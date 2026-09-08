import { GenericEvent } from '@polkadot/types/generic';
import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { FieldNotFound } from './errors';

/** An event's parameters keyed by field name */
export type DecodedEvent = Readonly<Record<string, Codec>>;

/**
 * The field names the block's own metadata gives this event, in parameter order.
 *
 * Since metadata v14 the metadata is self-describing: a struct-style event carries a name per
 * field and a tuple-style one carries none. `mapEvent` already straddles this boundary for
 * `typeName`; this reads the sibling `name`.
 */
export const metadataFieldNames = (event: SubstrateEvent): (string | undefined)[] =>
  (event.event as unknown as GenericEvent).meta.fields.map(({ name }) =>
    name.isSome ? name.unwrap().toString() : undefined
  );

/**
 * The declared type of each parameter, in parameter order.
 *
 * Metadata v14 moved the type onto `fields[i].typeName`; before it, `meta.args[i]` carried it.
 * Both eras are read here so the fallback lives in one place.
 */
export const metadataTypeNames = (event: SubstrateEvent): string[] => {
  const meta = (event.event as unknown as GenericEvent).meta;

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

  return event.event.data[index] as unknown as Codec;
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
    Object.fromEntries(
      names.map((name, index) => [name, event.event.data[index] as unknown as Codec])
    )
  );
};
