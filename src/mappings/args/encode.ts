import { Codec } from '@polkadot/types/types';
import { hexToU8a, stringCamelCase, u8aToHex } from '@polkadot/util';
import { ArgumentsJson } from '../../types';
import { asCodec } from '../../utils/codec';
import { codecBytes } from '../../utils/bytes';
import { paddedText, textOrHex } from '../../utils/text';
import { isType, typeNameOf } from './typeName';

export type CanonicalValue =
  | string
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

/**
 * Arguments in the canonical encoding as the `ArgumentsJson` the models declare. The generator can
 * only express a free-form JSON column as `{ _?: string }`, which no keyed object is assignable to;
 * the column stores whatever JSON it is given.
 */
export const argumentsJson = (args: Record<string, CanonicalValue>): ArgumentsJson =>
  args as unknown as ArgumentsJson;

export interface RawReference {
  kind: 'identity' | 'account' | 'asset' | 'ticker' | 'portfolio';
  value: string;
}

interface Walk {
  refs: RawReference[];
}

// The walk is deliberately duck-typed: a codec is recognised by the members the declared type says it
// has, not by its class, since the same type is built by different classes (and by a second copy of
// the codec package in the webpack bundle). These guards are that check, and each one fails loudly
// rather than reading `undefined` off a value that is not the shape its type name promised.
const hasMember = (codec: object, key: string, kind: 'function' | 'boolean' | 'string') =>
  key in codec && typeof (codec as Record<string, unknown>)[key] === kind;

const isInteger = (codec: Codec): boolean =>
  hasMember(codec, 'toBn', 'function') && hasMember(codec, 'bitLength', 'function');

interface CallLike {
  section: string;
  method: string;
  args: Codec[];
  meta: { args: { name: { toString(): string }; type: { toString(): string } }[] };
}

const isCall = (codec: Codec): codec is Codec & CallLike =>
  hasMember(codec, 'section', 'string') &&
  hasMember(codec, 'method', 'string') &&
  'args' in codec &&
  Array.isArray(codec.args) &&
  'meta' in codec &&
  typeof codec.meta === 'object' &&
  codec.meta !== null &&
  'args' in codec.meta &&
  Array.isArray(codec.meta.args);

const isOption = (codec: Codec): codec is Codec & { isSome: boolean; unwrap: () => Codec } =>
  hasMember(codec, 'isSome', 'boolean') && hasMember(codec, 'unwrap', 'function');

const isResult = (codec: Codec): codec is Codec & { isOk: boolean; asOk: Codec; asErr: Codec } =>
  hasMember(codec, 'isOk', 'boolean') && 'asOk' in codec && 'asErr' in codec;

const isEnum = (codec: Codec): codec is Codec & { type: string; isBasic: boolean; value: Codec } =>
  hasMember(codec, 'type', 'string') && hasMember(codec, 'isBasic', 'boolean') && 'value' in codec;

const mismatch = (raw: string, codec: Codec): Error =>
  new TypeError(`${raw} was expected, but the value is a ${codec.constructor.name}`);

const isFixedBytes = (raw: string): boolean => /^\[u8;\s*\d+\]$/.test(raw);

const parsedRaw = (raw: string): Record<string, unknown> | undefined => {
  if (!raw.startsWith('{')) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

/** Splits a list of type names at its top-level commas: `u32, Vec<(A, B)>` into two. */
const splitTypes = (list: string): string[] => {
  const types: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    if ('<([{'.includes(c)) {
      depth += 1;
    } else if ('>)]}'.includes(c)) {
      depth -= 1;
    } else if (c === ',' && depth === 0) {
      types.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  types.push(list.slice(start).trim());
  return types;
};

/**
 * The type names a container's raw type gives its children: `Vec<PolymeshPrimitivesTicker>`,
 * `(u32,IdentityId)`, `[Balance;4]`. The registry computes it, so it names them even where the
 * values themselves can't be asked.
 */
const childTypes = (raw: string): string[] => {
  const generic = /^\w+<([\s\S]*)>$/.exec(raw);
  if (generic) {
    return splitTypes(generic[1]);
  }
  const tuple = /^\(([\s\S]*)\)$/.exec(raw);
  if (tuple) {
    return splitTypes(tuple[1]);
  }
  const fixed = /^\[([\s\S]*);\s*\d+\]$/.exec(raw);
  return fixed ? [fixed[1].trim()] : [];
};

/** A child's type name from its parent's parsed raw type, when the parent names it. */
const named = (types: Record<string, unknown> | undefined, key: string): string | undefined => {
  const type = types?.[key];
  return typeof type === 'string' ? type : undefined;
};

/**
 * A portfolio's `did/number`: `Default` is 0, `User(n)` is n. Undefined for v7.4's
 * `AccountId(account)` kind, which the index holds as an account (`meshPortfolioToAssetHolder`), so
 * the account it names is the reference.
 */
const portfolioValue = (encoded: CanonicalValue): string | undefined => {
  if (!encoded || typeof encoded !== 'object' || Array.isArray(encoded)) {
    return undefined;
  }
  const { did, kind } = encoded as { did?: unknown; kind?: unknown };
  if (typeof did !== 'string') {
    return undefined;
  }
  if (kind === 'Default') {
    return `${did}/0`;
  }
  const number = kind && typeof kind === 'object' ? (kind as { User?: unknown }).User : undefined;
  return typeof number === 'string' ? `${did}/${number}` : undefined;
};

const addRef = (at: Walk, kind: RawReference['kind'], value: string): void => {
  at.refs.push({ kind, value });
};

const isBytes = (raw: string): boolean =>
  isFixedBytes(raw) || raw === 'Bytes' || raw === 'Text' || raw === 'Raw';

/** Text, a ticker, or hex; an identity's or asset's hex is also a reference. */
const encodeBytes = (codec: Codec, raw: string, name: string, at: Walk): CanonicalValue => {
  const bytes = hexToU8a(codec.toHex());
  if (raw === 'Text') {
    const text = codec.toString();
    return text.includes('\u0000') ? u8aToHex(codecBytes(codec)) : text;
  }
  if (isType(name, 'Ticker')) {
    addRef(at, 'ticker', u8aToHex(bytes));
    return paddedText(bytes);
  }
  if (raw === 'Bytes') {
    return textOrHex(codecBytes(codec));
  }
  const hex = u8aToHex(bytes);
  if (isType(name, 'IdentityId')) {
    addRef(at, 'identity', hex);
  } else if (isType(name, 'AssetId')) {
    addRef(at, 'asset', hex);
  }
  return hex;
};

const encodeCall = (codec: Codec, at: Walk): CanonicalValue => {
  if (!isCall(codec)) {
    throw mismatch('Call', codec);
  }
  const call = codec;
  const args: Record<string, CanonicalValue> = {};
  call.args.forEach((arg, i) => {
    args[stringCamelCase(call.meta.args[i].name.toString())] = walk(
      arg,
      call.meta.args[i].type.toString(),
      at
    );
  });
  return { section: call.section, method: call.method, args };
};

/** An `Option` or `Result`; `undefined` for anything else. */
const encodeWrapper = (codec: Codec, raw: string, at: Walk): CanonicalValue | undefined => {
  if (raw.startsWith('Option<')) {
    if (!isOption(codec)) {
      throw mismatch(raw, codec);
    }
    const option = codec;
    return option.isSome ? walk(option.unwrap(), childTypes(raw)[0], at) : null;
  }
  if (raw.startsWith('Result<')) {
    if (!isResult(codec)) {
      throw mismatch(raw, codec);
    }
    const result = codec;
    const [okType, errType] = childTypes(raw);
    return result.isOk
      ? { ok: walk(result.asOk, okType, at) }
      : { err: walk(result.asErr, errType, at) };
  }
  return undefined;
};

/** A map or a set; `undefined` for anything else. */
const encodeCollection = (codec: Codec, raw: string, at: Walk): CanonicalValue | undefined => {
  if (raw.startsWith('BTreeMap<') || raw.startsWith('HashMap<')) {
    const [keyType, valueType] = childTypes(raw);
    if (!(codec instanceof Map)) {
      throw mismatch(raw, codec);
    }
    return [...codec.entries()].map(([key, value]) => [
      walk(key, keyType, at),
      walk(value, valueType, at),
    ]);
  }
  if (raw.startsWith('BTreeSet<')) {
    const [valueType] = childTypes(raw);
    if (!(codec instanceof Set)) {
      throw mismatch(raw, codec);
    }
    return [...codec].map(value => walk(value, valueType, at));
  }
  return undefined;
};

/** An `Option`, `Result`, map, set, `Vec`, tuple or fixed array; `undefined` for anything else. */
const encodeContainer = (codec: Codec, raw: string, at: Walk): CanonicalValue | undefined => {
  // a `None` encodes as null, so test for `undefined` rather than for a missing value
  const wrapped = encodeWrapper(codec, raw, at);
  if (wrapped !== undefined) {
    return wrapped;
  }
  const collected = encodeCollection(codec, raw, at);
  if (collected !== undefined) {
    return collected;
  }
  if (Array.isArray(codec)) {
    const types = childTypes(raw);
    // a tuple names each member; a Vec or a fixed array names one type for all of them
    return codec.map((value, i) => walk(value, types.length > 1 ? types[i] : types[0], at));
  }
  return undefined;
};

/** An enum as its variant, or a struct keyed by field; a portfolio is also a reference. */
const encodeShaped = (
  codec: Codec,
  shape: Record<string, unknown>,
  name: string,
  at: Walk
): CanonicalValue => {
  if ('_enum' in shape) {
    if (!isEnum(codec)) {
      throw mismatch(name, codec);
    }
    const variant = codec;
    if (variant.isBasic || variant.value.toRawType() === 'Null') {
      return variant.type;
    }
    const types = shape._enum as Record<string, unknown>;
    return { [variant.type]: walk(variant.value, named(types, variant.type), at) };
  }
  const struct: Record<string, CanonicalValue> = {};
  if (!(codec instanceof Map)) {
    throw mismatch(name, codec);
  }
  for (const [key, value] of codec.entries()) {
    struct[stringCamelCase(key)] = walk(value, named(shape, key), at);
  }
  const portfolio = isType(name, 'PortfolioId') ? portfolioValue(struct) : undefined;
  if (portfolio) {
    // the portfolio before the identity its `did` added
    at.refs.splice(-1, 0, { kind: 'portfolio', value: portfolio });
  }
  return struct;
};

const walk = (codec: Codec, hint: string | undefined, at: Walk): CanonicalValue => {
  const raw = codec.toRawType();
  const name = typeNameOf(codec, hint);

  if (raw === 'Null' || raw === '()') {
    return null;
  }
  if (raw === 'bool') {
    return codec.toPrimitive() as boolean;
  }
  if (isInteger(codec)) {
    return codec.toString();
  }
  if (raw.startsWith('AccountId') || isType(name, 'AccountId32')) {
    const value = codec.toString();
    addRef(at, 'account', value);
    return value;
  }
  if (isBytes(raw)) {
    return encodeBytes(codec, raw, name, at);
  }
  if (raw === 'Call') {
    return encodeCall(codec, at);
  }
  const contained = encodeContainer(codec, raw, at);
  if (contained !== undefined) {
    return contained;
  }
  const shape = parsedRaw(raw);
  if (shape) {
    return encodeShaped(codec, shape, name, at);
  }

  // anything else polkadot can describe: integers inside are still strings
  return JSON.parse(
    JSON.stringify(codec.toPrimitive(), (_, v) => (typeof v === 'number' ? String(v) : v))
  ) as CanonicalValue;
};

/** One value in the canonical encoding (plan 09 §9.10), and the references it contains. */
export const encodeValue = (
  codec: Codec,
  hint?: string,
  refs: RawReference[] = []
): CanonicalValue => walk(codec, hint, { refs });

/**
 * An event's or call's arguments: keyed by name when the metadata names every one, by position
 * otherwise, so a JSONB `contains` filter can always say which argument it means.
 */
export const encodeArgs = (
  values: Codec[],
  names: (string | undefined)[],
  types: string[]
): { args: Record<string, CanonicalValue>; refs: RawReference[] } => {
  const named = values.length > 0 && names.length === values.length && names.every(Boolean);
  const refs: RawReference[] = [];
  const args: Record<string, CanonicalValue> = {};

  values.forEach((value, i) => {
    const key = named ? (names[i] as string) : String(i);
    args[key] = encodeValue(value, types[i], refs);
  });

  return { args, refs };
};

/**
 * What `callArgs` reads of a call: its arguments and the metadata naming them. Taken structurally
 * because a `Call` and a `GenericCall` are the same object, and the arguments' element type is
 * declared by two copies of the codec package that the webpack build keeps apart.
 */
export interface CallSource {
  args: ArrayLike<unknown>;
  meta: { args: { name: { toString(): string }; type: { toString(): string } }[] };
}

/** A call's arguments in the canonical encoding, keyed by the metadata's argument names. */
export const callArgs = (call: CallSource): Record<string, CanonicalValue> =>
  encodeArgs(
    Array.from(call.args, asCodec),
    call.meta.args.map(({ name }) => stringCamelCase(name.toString())),
    call.meta.args.map(({ type }) => type.toString())
  ).args;
