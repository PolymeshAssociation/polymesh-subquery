import { GenericEvent } from '@polkadot/types/generic';
import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { FieldNotFound } from './errors';

/** An event's parameters keyed by field name */
export type DecodedEvent = Readonly<Record<string, Codec>>;

/**
 * `asset_id` -> `assetId`. A no-op for a name with no underscore, so an already-camelCase name
 * (the common case so far) passes through unchanged rather than being lowercased.
 */
const toCamelCase = (name: string): string =>
  name.includes('_')
    ? name.replace(/_([a-zA-Z0-9])/g, (_match, c: string) => c.toUpperCase())
    : name;

/**
 * One parameter of an event's data as a `Codec`. `tsc` accepts the data's own element type, but the
 * webpack build resolves `Codec` from a second declaration and rejects it, so this is the one place
 * that bridges the two. Every element of event data is a codec at runtime.
 */
export const codecAt = (data: ArrayLike<unknown>, index: number): Codec => data[index] as Codec;

/**
 * SubQuery types an event as `IEvent`, which lacks the metadata every real event carries. The
 * check is by shape rather than `instanceof`, since the webpack build can bundle a second copy of
 * the class.
 */
const hasMeta = (candidate: object): candidate is GenericEvent =>
  'meta' in candidate && typeof candidate.meta === 'object' && candidate.meta !== null;

const eventMeta = (event: SubstrateEvent): GenericEvent['meta'] => {
  if (!hasMeta(event.event)) {
    throw new FieldNotFound(event.event.section, event.event.method, '<metadata>', []);
  }

  return event.event.meta;
};

/**
 * The field names the block's own metadata gives this event, in parameter order.
 *
 * Since metadata v14 the metadata is self-describing: a struct-style event carries a name per
 * field and a tuple-style one carries none. `mapEvent` already straddles this boundary for
 * `typeName`; this reads the sibling `name`.
 *
 * Substrate's own macros name fields idiomatic-Rust snake_case (`asset_id`), while every shape
 * table and handler in this codebase reads camelCase (`assetId`) - the convention `#[derive]`d
 * upstream-pallet events (and, on a later runtime, some of Polymesh's own) already happen to
 * satisfy only when the name has no underscore to begin with. Normalising here, once, is what
 * lets the shape table and every handler stay camelCase-only.
 */
export const metadataFieldNames = (event: SubstrateEvent): (string | undefined)[] =>
  eventMeta(event).fields.map(({ name }) =>
    name.isSome ? toCamelCase(name.unwrap().toString()) : undefined
  );

/**
 * The declared type of each parameter, in parameter order.
 *
 * Metadata v14 moved the type onto `fields[i].typeName`; before it, `meta.args[i]` carried it.
 * Both eras are read here so the fallback lives in one place.
 */
export const metadataTypeNames = (event: SubstrateEvent): string[] => {
  const meta = eventMeta(event);

  return meta.fields.map(({ typeName }, index) =>
    typeName.isSome ? typeName.unwrap().toString() : meta.args[index].toString()
  );
};

/**
 * Whether the block's metadata names every field of this event.
 *
 * Upstream Substrate pallets declare struct-style events, so everything they emit is named.
 * Polymesh's own pallets declare tuple-style events, which carry no names at any spec version
 * and are decoded from the registered shape table instead.
 */
export const hasNamedFields = (event: SubstrateEvent): boolean => {
  const names = metadataFieldNames(event);

  return names.length > 0 && names.every(name => name !== undefined);
};

/**
 * The parameter `name` refers to, resolved against the block's own metadata.
 *
 * Position is read per block, so a field inserted or reordered by a runtime upgrade resolves
 * correctly with no version branch in the handler. This is what makes decoding spec-version
 * agnostic for every named event.
 *
 * @throws FieldNotFound when the event carries no field of that name
 */
export const field = (event: SubstrateEvent, name: string): Codec => {
  const names = metadataFieldNames(event);
  const index = names.indexOf(name);

  if (index < 0) {
    throw new FieldNotFound(
      event.event.section,
      event.event.method,
      name,
      names.map(available => available ?? '<unnamed>')
    );
  }

  return codecAt(event.event.data, index);
};

/**
 * Every parameter of a named event, keyed by field name.
 *
 * `undefined` when the event is tuple-style, which is the signal to fall back to the registered
 * shape table.
 */
export const namedFields = (event: SubstrateEvent): DecodedEvent | undefined => {
  if (!hasNamedFields(event)) {
    return undefined;
  }

  const names = metadataFieldNames(event);

  return Object.freeze(
    Object.fromEntries(names.map((name, index) => [name, codecAt(event.event.data, index)]))
  );
};

/**
 * A decoded field that an event may or may not carry, as `undefined` rather than a throw.
 *
 * The named-field proxy throws on an absent key deliberately — a handler asking for a field the
 * event does not have is a bug worth surfacing. This is for the cases where absence is the
 * information: a field one runtime added, or one an upstream pallet declares and Polymesh's own
 * version of the same event does not. Both spellings are tried, since a struct event names fields
 * snake_case upstream while the shape tables and handlers read camelCase.
 */
export const optionalField = (decoded: DecodedEvent, name: string): Codec | undefined => {
  const snake = name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

  for (const candidate of new Set([name, snake, toCamelCase(name)])) {
    if (candidate in decoded) {
      return decoded[candidate];
    }
  }

  return undefined;
};
