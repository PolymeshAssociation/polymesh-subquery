import { Codec } from '@polkadot/types/types';

/**
 * Reads of chain values whose type the compiler cannot know: storage queries resolve to a bare
 * `Codec`, and the members a handler wants (`isSome`, a struct field, an enum flag) exist only on
 * the concrete class the runtime built. Each reader checks the member it goes on to use and throws
 * a `TypeError` naming it, so a runtime that changes the shape fails here, at the read, rather than
 * as an `undefined` several calls later.
 */

const describe = (value: unknown): string =>
  value === null || value === undefined ? String(value) : value.constructor?.name ?? typeof value;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * A value as the `@polkadot/types` `Codec` the helpers in this codebase take. `tsc` treats the
 * codec packages' two declarations as one type, but the webpack build resolves them separately and
 * rejects an assignment between the two; the objects are the same at runtime.
 */
export const asCodec = (value: unknown): Codec => value as Codec;

/** The value inside an `Option`, or `undefined` when it is `None`. */
export const optionOf = (value: unknown, what: string): Codec | undefined => {
  if (!isObject(value) || typeof value.isSome !== 'boolean' || typeof value.unwrap !== 'function') {
    throw new TypeError(`${what} was expected to be an Option, but is ${describe(value)}`);
  }

  return value.isSome ? asCodec(value.unwrap()) : undefined;
};

/** A boolean member of a codec, such as the `isNonFungible` of an enum. */
export const flagOf = (value: unknown, key: string): boolean => {
  const flag = isObject(value) ? value[key] : undefined;

  if (typeof flag !== 'boolean') {
    throw new TypeError(`${key} was expected on ${describe(value)}`);
  }

  return flag;
};

/** A named field of a struct codec that some runtimes lack, or `undefined` when it is absent. */
export const optionalMemberOf = (value: unknown, key: string): Codec | undefined =>
  isObject(value) && key in value ? asCodec(value[key]) : undefined;

/** A named field of a struct codec. */
export const memberOf = (value: unknown, key: string): Codec => {
  if (!isObject(value) || !(key in value)) {
    throw new TypeError(`${key} was expected on ${describe(value)}`);
  }

  return asCodec(value[key]);
};

/** Whether a value is a non-null object, for the shape checks that read a codec's JSON. */
export const isRecord = isObject;

/**
 * A codec's `toJSON()` as the shape the caller reads, after `check` has confirmed it. `toJSON()` is
 * typed as arbitrary JSON, so reading a field off it needs either a cast or a check; the check is
 * the one that notices a runtime that changed the shape.
 */
export const jsonOf = <T>(codec: Codec, check: (json: unknown) => json is T, what: string): T => {
  const json: unknown = codec.toJSON();

  if (!check(json)) {
    throw new TypeError(`${what} did not have the expected shape: ${JSON.stringify(json)}`);
  }

  return json;
};

const isIterable = (value: unknown): value is Iterable<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  Symbol.iterator in value &&
  typeof value[Symbol.iterator] === 'function';

/** The members of a `Vec`, tuple or set codec, which all iterate; throws on anything else. */
export const itemsOf = (value: unknown, what: string): Codec[] => {
  if (!isIterable(value)) {
    throw new TypeError(`${what} was expected to be a list, but is ${describe(value)}`);
  }

  return Array.from(value, asCodec);
};
