import { Codec } from '@polkadot/types/types';

/**
 * Reads of chain values whose type the compiler cannot know: storage queries resolve to a bare
 * `Codec`, and the members a handler wants (`isSome`, a struct field, an enum flag) exist only on
 * the concrete class the runtime built. Each reader checks the member it goes on to use and throws
 * an `UnexpectedShapeError` naming it, so a runtime that changes the shape fails here, at the read,
 * rather than as an `undefined` several calls later.
 */

/** A value did not have the members its declared type promised. A `TypeError`, so a plain catch still sees it. */
export class UnexpectedShapeError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'UnexpectedShapeError';
  }
}

const describe = (value: unknown): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return value.constructor?.name ?? typeof value;
};

/** Whether a value is a non-null object, for the shape checks that read a codec's JSON. */
export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** An enum's variant, lower-cased, whether its JSON is the bare name or `{ variant: value }` */
export const variantOf = (json: unknown): string => {
  if (typeof json === 'string') {
    return json.toLowerCase();
  }
  return isObject(json) ? (Object.keys(json)[0] ?? '').toLowerCase() : '';
};

/** Whether `value` has a member `key` that is a function, for the dispatch that must not throw. */
export const hasFunction = (value: unknown, key: string): boolean =>
  isObject(value) && typeof value[key] === 'function';

/** A member the readers below have checked for, as the `Codec` it is at runtime. */
const asCodec = (value: unknown): Codec => value as Codec;

/** The value inside an `Option`, or `undefined` when it is `None`. */
export const optionOf = (value: unknown, what: string): Codec | undefined => {
  if (!isObject(value) || typeof value.isSome !== 'boolean' || typeof value.unwrap !== 'function') {
    throw new UnexpectedShapeError(
      `${what} was expected to be an Option, but is ${describe(value)}`
    );
  }

  return value.isSome ? asCodec(value.unwrap()) : undefined;
};

/** A boolean member of a codec, such as the `isNonFungible` of an enum. */
export const flagOf = (value: unknown, key: string): boolean => {
  const flag = isObject(value) ? value[key] : undefined;

  if (typeof flag !== 'boolean') {
    throw new UnexpectedShapeError(`${key} was expected on ${describe(value)}`);
  }

  return flag;
};

/** A string member of a codec, such as the `section` of a call or the `type` of an enum. */
export const textOf = (value: unknown, key: string): string => {
  const text = isObject(value) ? value[key] : undefined;

  if (typeof text !== 'string') {
    throw new UnexpectedShapeError(`${key} was expected on ${describe(value)}`);
  }

  return text;
};

/** A named field of a struct codec that some runtimes lack, or `undefined` when it is absent. */
export const optionalMemberOf = (value: unknown, key: string): Codec | undefined =>
  isObject(value) && key in value ? asCodec(value[key]) : undefined;

/** A named field of a struct codec. */
export const memberOf = (value: unknown, key: string): Codec => {
  if (!isObject(value) || !(key in value)) {
    throw new UnexpectedShapeError(`${key} was expected on ${describe(value)}`);
  }

  return asCodec(value[key]);
};

/**
 * A struct codec's field by name, whatever casing its decoding gave it: snake_case from the type
 * bundle before metadata v14, camelCase from v14. `undefined` when the struct has no such field.
 */
export const fieldOf = (value: Codec, name: string): Codec | undefined => {
  const wanted = name.replace(/_/g, '').toLowerCase();
  const entries = (value as unknown as Map<string, Codec>).entries();
  for (const [key, field] of entries) {
    if (key.replace(/_/g, '').toLowerCase() === wanted) {
      return field;
    }
  }
  return undefined;
};

/**
 * A codec's `toJSON()` as the shape the caller reads, after `check` has confirmed it. `toJSON()` is
 * typed as arbitrary JSON, so reading a field off it needs either a cast or a check; the check is
 * the one that notices a runtime that changed the shape.
 */
export const jsonOf = <T>(codec: Codec, check: (json: unknown) => json is T, what: string): T => {
  const json: unknown = codec.toJSON();

  if (!check(json)) {
    throw new UnexpectedShapeError(
      `${what} did not have the expected shape: ${JSON.stringify(json)}`
    );
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
    throw new UnexpectedShapeError(`${what} was expected to be a list, but is ${describe(value)}`);
  }

  return Array.from(value, asCodec);
};
