import { GenericCall } from '@polkadot/types';
import { Codec } from '@polkadot/types/types';
import { hexToU8a, stringCamelCase, u8aToHex } from '@polkadot/util';
import { codecBytes } from '../../utils/bytes';
import { paddedText, textOrHex } from '../../utils/text';
import { isType, typeNameOf } from './typeName';

export type CanonicalValue =
  | string
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export interface RawReference {
  kind: 'identity' | 'account' | 'asset' | 'ticker' | 'portfolio';
  value: string;
}

interface Walk {
  refs: RawReference[];
}

const isInteger = (codec: Codec): boolean =>
  typeof (codec as unknown as { toBn?: unknown }).toBn === 'function' &&
  typeof (codec as unknown as { bitLength?: unknown }).bitLength === 'function';

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
  const call = codec as unknown as {
    section: string;
    method: string;
    args: Codec[];
    meta: { args: { name: { toString(): string }; type: { toString(): string } }[] };
  };
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

/** An `Option`, `Result`, map, set, `Vec`, tuple or fixed array; `undefined` for anything else. */
const encodeContainer = (codec: Codec, raw: string, at: Walk): CanonicalValue | undefined => {
  if (raw.startsWith('Option<')) {
    const option = codec as unknown as { isSome: boolean; unwrap: () => Codec };
    return option.isSome ? walk(option.unwrap(), childTypes(raw)[0], at) : null;
  }
  if (raw.startsWith('Result<')) {
    const result = codec as unknown as { isOk: boolean; asOk: Codec; asErr: Codec };
    const [okType, errType] = childTypes(raw);
    return result.isOk
      ? { ok: walk(result.asOk, okType, at) }
      : { err: walk(result.asErr, errType, at) };
  }
  if (raw.startsWith('BTreeMap<') || raw.startsWith('HashMap<')) {
    const [keyType, valueType] = childTypes(raw);
    return [...(codec as unknown as Map<Codec, Codec>).entries()].map(([key, value]) => [
      walk(key, keyType, at),
      walk(value, valueType, at),
    ]);
  }
  if (raw.startsWith('BTreeSet<')) {
    const [valueType] = childTypes(raw);
    return [...(codec as unknown as Set<Codec>)].map(value => walk(value, valueType, at));
  }
  if (Array.isArray(codec)) {
    const types = childTypes(raw);
    // a tuple names each member; a Vec or a fixed array names one type for all of them
    return (codec as unknown as Codec[]).map((value, i) =>
      walk(value, types.length > 1 ? types[i] : types[0], at)
    );
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
    const variant = codec as unknown as { type: string; isBasic: boolean; value: Codec };
    if (variant.isBasic || variant.value.toRawType() === 'Null') {
      return variant.type;
    }
    const types = shape._enum as Record<string, unknown>;
    return { [variant.type]: walk(variant.value, named(types, variant.type), at) };
  }
  const struct: Record<string, CanonicalValue> = {};
  for (const [key, value] of (codec as unknown as Map<string, Codec>).entries()) {
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

/** A call's arguments in the canonical encoding, keyed by the metadata's argument names. */
export const callArgs = (call: GenericCall): Record<string, CanonicalValue> =>
  encodeArgs(
    call.args,
    call.meta.args.map(({ name }) => stringCamelCase(name.toString())),
    call.meta.args.map(({ type }) => type.toString())
  ).args;
