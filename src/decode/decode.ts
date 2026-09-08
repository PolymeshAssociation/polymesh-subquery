import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { EventIdEnum, ModuleIdEnum } from '../types';
import { recordAnomaly } from '../utils/anomaly';
import { DecodeError, FieldNotFound } from './errors';
import { DecodedEvent, namedFields } from './field';
import { resolveShape } from './shapes';
import { normaliseSpecVersion } from './specVersion';

/**
 * Property names a decoded event must answer without complaint.
 *
 * The guard below turns an unknown field into a throw, and these are the names runtimes and test
 * tooling probe for on any object - `then` decides whether a value is awaited, the rest are
 * inspection hooks. Throwing on them would break unrelated machinery.
 */
const PROBED_PROPERTIES = new Set([
  'then',
  'toJSON',
  'inspect',
  'constructor',
  'hasOwnProperty',
  'nodeType',
]);

const asModuleId = (section: string): ModuleIdEnum | undefined => {
  const moduleId = section.toLowerCase();

  return Object.values(ModuleIdEnum).includes(moduleId as ModuleIdEnum)
    ? (moduleId as ModuleIdEnum)
    : undefined;
};

const asEventId = (method: string): EventIdEnum | undefined =>
  Object.values(EventIdEnum).includes(method as EventIdEnum) ? (method as EventIdEnum) : undefined;

const record = (event: SubstrateEvent, error: DecodeError): void => {
  /**
   * Dropped deliberately: decoding is synchronous, and an anomaly row is a diagnostic. See
   * `recordAnomaly`
   */
  void recordAnomaly({
    kind: error.kind,
    detail: error.message,
    block: event.block,
    eventIdx: event.idx,
    moduleId: asModuleId(error.moduleId),
    eventId: asEventId(error.eventId),
  });
};

/**
 * Wraps a decoded event so that reading a field it does not carry throws instead of yielding
 * `undefined`.
 *
 * Without this, a name misspelled in a handler or in the shape table is invisible: the
 * destructure succeeds, the value is `undefined`, and a wrong row is written. That is the exact
 * class of defect the decode layer exists to remove, so it is closed here rather than left to
 * review.
 */
const guard = (event: SubstrateEvent, decoded: Record<string, Codec>): DecodedEvent =>
  new Proxy(Object.freeze(decoded), {
    get(target, property, receiver) {
      if (typeof property !== 'string' || property in target || PROBED_PROPERTIES.has(property)) {
        return Reflect.get(target, property, receiver);
      }

      const error = new FieldNotFound(
        event.event.section,
        event.event.method,
        property,
        Object.keys(target)
      );

      record(event, error);

      throw error;
    },
  });

/**
 * An event's parameters keyed by name.
 *
 * Two sources, in order:
 *
 * 1. the block's own metadata, for struct-style events, which since v14 name every field. This
 *    is immune to a field being inserted or reordered by a runtime upgrade, and covers every
 *    upstream Substrate pallet;
 * 2. the registered shape table, for Polymesh's tuple-style events, which carry no names at any
 *    spec version.
 *
 * Both failure modes - no decoder for the spec version, and a parameter count that disagrees
 * with the one registered - are recorded as an `IndexerAnomaly` and then thrown. Nothing here
 * returns a partial decode.
 */
export const decodeEvent = (event: SubstrateEvent): DecodedEvent => {
  const named = namedFields(event);

  if (named) {
    return guard(event, { ...named });
  }

  const { section, method, data } = event.event;

  try {
    const shape = resolveShape(
      section,
      method,
      normaliseSpecVersion(event.block.specVersion),
      data.length
    );

    /**
     * Every declared field is present as a key, including the trailing ones a shorter event did
     * not carry. Those read as `undefined`, which is what the handlers reading them already
     * expect; a name the shape does not declare at all still throws
     */
    return guard(
      event,
      Object.fromEntries(shape.fields.map((name, index) => [name, data[index] as unknown as Codec]))
    );
  } catch (error) {
    if (error instanceof DecodeError) {
      record(event, error);
    }

    throw error;
  }
};
