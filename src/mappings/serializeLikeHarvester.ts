import { GenericCall, GenericExtrinsic, u64 } from '@polkadot/types';
import {
  CodecMap,
  Compact,
  Enum,
  Option,
  Result,
  Struct,
  Tuple,
  Vec,
  VecFixed,
} from '@polkadot/types/codec';
import { AnyJson, AnyTuple, Codec } from '@polkadot/types/types';
import { hexStripPrefix, u8aToHex } from '@polkadot/util';
import { decodeAddress } from '@polkadot/util-crypto';
import BN from 'bn.js';
import { TextDecoder } from 'util';
import {
  camelToSnakeCase,
  capitalizeFirstLetter,
  findTopLevelCommas,
  fromEntries,
  removeNullChars,
  serializeTicker,
} from '../utils';

/** A value to serialise: the codec, its declared type, its raw type, and whether it is a call argument. */
interface Serialising {
  item: Codec;
  type: string;
  rawType: string;
  isCallArg: boolean;
}

/** One of the harvester's encodings: which values it applies to, and how it writes them. */
interface HarvesterRule {
  applies: (value: Serialising) => boolean;
  serialize: (value: Serialising) => AnyJson;
}

const serializeMoment = (item: Codec): string => {
  const isoParts = new Date((item as unknown as Compact<u64>).toNumber())
    .toISOString()
    .slice(0, -1) // remove Z
    .split('.');

  if (!Number.parseInt(isoParts[1])) {
    return isoParts[0];
  }

  isoParts[1] = (isoParts[1] + '000000').slice(0, 6); // the harvester likes 6 digits of precision but only when it is not 0 ¯\_(ツ)_/¯
  return isoParts.join('.');
};

const serializeBytes = (item: Codec): AnyJson => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    return removeNullChars(decoder.decode(Buffer.from(hexStripPrefix(item.toString()), 'hex')));
  } catch {
    return item.toJSON();
  }
};

const serializeCall = (item: Codec): AnyJson => {
  const call = item as unknown as GenericCall;
  const hexCallIndex =
    call.callIndex instanceof Uint8Array
      ? u8aToHex(call.callIndex)
      : call.getT('callIndex').toString();

  return {
    call_index: hexStripPrefix(hexCallIndex),
    call_function: camelToSnakeCase(call.method),
    call_module: capitalizeFirstLetter(call.section),
    call_args: serializeCallArgsLikeHarvester(call),
  };
};

const serializeElectionScore = ({ item, rawType }: Serialising): AnyJson => {
  // In newer Substrate versions ElectionScore became a named struct (SpNposElectionsElectionScore)
  // rather than a plain tuple/array of BN values. Fall back to the struct serializer in that case.
  if (isStructType(rawType)) {
    const types = extractStructTypes(item as unknown as Struct, rawType);
    return fromEntries((item as unknown as Struct).entries(), (v, _, k) =>
      serializeLikeHarvester(v, types[k])
    );
  }
  return (item as unknown as BN[]).map(n => Number.parseInt(n.toString())); // This might not work for big numbers but that's the way the harvester does it.
};

const serializeResult = ({ item, type, rawType }: Serialising): AnyJson => {
  const result = item as unknown as Result<any, any>;
  const types = extractResultTypes(result, type, rawType);

  // Harvester likes "Error" instead of "Err"
  return result.isOk
    ? { Ok: serializeLikeHarvester(result.value, types.ok) }
    : { Error: serializeLikeHarvester(result.value, types.err) };
};

const serializeEnum = ({ item, type, rawType }: Serialising): AnyJson => {
  const enumItem = item as unknown as Enum;
  const variant = capitalizeFirstLetter(enumItem.type);
  const valueType = extractEnumType(enumItem, type, variant, rawType);

  return enumItem.isBasic
    ? variant
    : { [variant]: serializeLikeHarvester(enumItem.value, valueType) };
};

/**
 * The harvester's encodings, tried in order; the first that applies writes the value, and a value
 * none applies to is written as its `toJSON()`.
 *
 * The tests have to be string comparisons because a value does not have the right prototype chain
 * to be compared with `instanceof`. All the harvester's special cases are kept in this one list, so
 * they are easy to find. The shape tests read the raw type already computed: the `isX(item)`
 * helpers recompute it, and a struct's or call's raw type is rebuilt from the registry every time.
 */
const HARVESTER_RULES: HarvesterRule[] = [
  {
    applies: ({ rawType }) => rawType === 'Compact<Moment>',
    serialize: ({ item }) => serializeMoment(item),
  },
  { applies: ({ rawType }) => rawType === 'AccountId', serialize: ({ item }) => item.toHex() },
  { applies: ({ rawType }) => rawType === '()', serialize: () => null },
  { applies: ({ type }) => type === 'HexBytes', serialize: ({ item }) => item.toJSON() },
  { applies: ({ rawType }) => rawType === 'Bytes', serialize: ({ item }) => serializeBytes(item) },
  {
    applies: ({ rawType }) => rawType === 'Text',
    serialize: ({ item }) => removeNullChars(item.toString()),
  },
  {
    applies: ({ type }) => type === 'Ticker' || type === 'PolymeshPrimitivesTicker',
    serialize: ({ item }) => serializeTicker(item),
  },
  {
    applies: ({ rawType }) => rawType.startsWith('[u8;') && rawType.endsWith(']'),
    serialize: ({ item }) => item.toHex(),
  },
  { applies: ({ rawType }) => rawType === 'Call', serialize: ({ item }) => serializeCall(item) },
  {
    // the harvester decodes a call's lookup sources differently from an event's
    applies: ({ type, isCallArg }) => isCallArg && type === 'Vec<LookupSource>',
    serialize: ({ item }) =>
      (item as Vec<any>).map(i =>
        hexStripPrefix(u8aToHex(decodeAddress(i.toString(), false, item.registry.chainSS58)))
      ),
  },
  {
    applies: ({ type }) => type === 'LookupSource',
    serialize: ({ item }) =>
      u8aToHex(decodeAddress(item.toString(), false, item.registry.chainSS58)),
  },
  {
    applies: ({ type }) => type === 'Balance',
    serialize: ({ item }) => Number.parseInt(item.toString()), // This might not work for big numbers but it's the way the harvester does it.
  },
  { applies: ({ type }) => type === 'ElectionScore', serialize: serializeElectionScore },
  {
    applies: ({ rawType }) => isTupleType(rawType),
    serialize: ({ item, type, rawType }) => {
      const types = extractTupleTypes(item as unknown as Tuple, type, rawType);
      return fromEntries(
        (item as unknown as AnyTuple).map((v, i) => [`col${i + 1}`, v]),
        (v, i) => serializeLikeHarvester(v, types[i])
      );
    },
  },
  {
    applies: ({ rawType }) => isArrayType(rawType),
    serialize: ({ item, type, rawType }) => {
      // item.Type === "Type" therefore string manipulation.
      const array = item as unknown as VecFixed<any>;
      const innerType = extractArrayType(array, type, rawType);
      return array.map(v => serializeLikeHarvester(v, innerType));
    },
  },
  {
    applies: ({ rawType }) => isVecType(rawType),
    serialize: ({ item, type, rawType }) => {
      // item.Type === "Type" therefore string manipulation.
      const vec = item as unknown as Vec<any>;
      const innerType = extractVecType(vec, type, rawType);
      return vec.map(v => serializeLikeHarvester(v, innerType));
    },
  },
  { applies: ({ rawType }) => isResultType(rawType), serialize: serializeResult },
  { applies: ({ rawType }) => isEnumType(rawType), serialize: serializeEnum },
  {
    applies: ({ rawType }) => isStructType(rawType),
    serialize: ({ item, type, rawType }) => {
      const struct = item as unknown as Struct;
      const types = extractStructTypes(struct, type, rawType);
      return fromEntries(struct.entries(), (v, _, k) => serializeLikeHarvester(v, types[k]));
    },
  },
  {
    applies: ({ rawType }) => isOptionType(rawType),
    serialize: ({ item, type, rawType }) => {
      const option = item as unknown as Option<any>;
      return option.isSome
        ? serializeLikeHarvester(option.value, extractOptionType(option, type, rawType))
        : null;
    },
  },
  {
    // a BTreeMap or HashMap
    applies: ({ rawType }) => isMapType(rawType),
    serialize: ({ item, type, rawType }) => {
      const map = item as unknown as CodecMap<any>;
      const { value } = extractMapTypes(map, type, rawType);
      return fromEntries(map.entries(), v => serializeLikeHarvester(v, value));
    },
  },
];

/**
 * @returns A json representation of `item` serialized using the same rules as the harvester.
 * @param item The Codec to be deserialized.
 * @param type The actual type (as opposed to raw type) of item
 * @param isCallArg true if item is an argument in a Call (the harvester deserializes LookupSources differently based on this)
 */
export const serializeLikeHarvester = (item: Codec, type: string, isCallArg = false): AnyJson => {
  if (typeof item !== 'object') {
    return item;
  }

  const value: Serialising = { item, type, rawType: item.toRawType(), isCallArg };
  const rule = HARVESTER_RULES.find(({ applies }) => applies(value));

  return rule ? rule.serialize(value) : item.toJSON();
};

export type HarvesterLikeCallArgs = { name: string; value: any }[];

export const serializeCallArgsLikeHarvester = (
  extrinsic: GenericCall | GenericExtrinsic
): HarvesterLikeCallArgs => {
  const meta = extrinsic.meta.args;
  return extrinsic.args.map((arg, i) => ({
    name: camelToSnakeCase(meta[i].name.toString()),
    value: serializeLikeHarvester(arg, meta[i].type.toString(), true),
  }));
};

/**
 * The raw type of structs has the following shape:
 * { "field_name": "FieldType" }
 * And enums, the following shape:
 * { "_enum": { "VariantName": "VariantType" } }
 * Meaning in order to extract the inner types, we must parse
 * the raw type as JSON.
 */
const parsedTypes = new Map<string, any>();

export const parseType = (type: string): any => {
  if (!type.startsWith('{')) {
    return undefined;
  }

  // a type's definition is fixed, so each distinct one is parsed once; there are a few hundred
  let parsed = parsedTypes.get(type);
  if (parsed === undefined) {
    parsed = JSON.parse(type);
    parsedTypes.set(type, parsed);
  }

  return parsed;
};

const isTupleType = (type: string) => type.length > 2 && type.startsWith('(') && type.endsWith(')');
export const isTuple = (item: Codec): item is Tuple => isTupleType(item.toRawType());

const isVecType = (type: string) => type.startsWith('Vec<');
export const isVec = (item: Codec): item is Vec<any> => isVecType(item.toRawType());

const isArrayType = (type: string) => type.startsWith('[') && type.endsWith(']');
export const isArray = (item: Codec): item is VecFixed<any> => isArrayType(item.toRawType());

const isOptionType = (type: string) => type.startsWith('Option<');
export const isOption = (item: Codec): item is Option<any> => isOptionType(item.toRawType());

const isResultType = (type: string) => type.startsWith('Result<');
export const isResult = (item: Codec): item is Result<any, any> => isResultType(item.toRawType());

const isMapType = (type: string) => type.startsWith('BTreeMap<') || type.startsWith('HashMap<');
export const isMap = (item: Codec): item is CodecMap<any> => isMapType(item.toRawType());

const isEnumType = (type: string) => parseType(type)?._enum !== undefined;
export const isEnum = (item: Codec): item is Enum => isEnumType(item.toRawType());

const isStructType = (type: string) => {
  const parsedType = parseType(type);
  return parsedType && parsedType._enum === undefined;
};
export const isStruct = (item: Codec): item is Struct => isStructType(item.toRawType());

export const extractOptionType = (item: Option<any>, t: string, rawType?: string): string => {
  const type = isOptionType(t) ? t : rawType ?? item.toRawType();
  return type.slice(7, -1);
};
export const extractVecType = (item: Vec<any>, t: string, rawType?: string): string => {
  const type = isVecType(t) ? t : rawType ?? item.toRawType();
  return type.slice(4, -1);
};
export const extractArrayType = (item: VecFixed<any>, t: string, rawType?: string): string => {
  const type = isArrayType(t) ? t : rawType ?? item.toRawType();
  return type.slice(1, type.lastIndexOf(';'));
};
export const extractTupleTypes = (item: Tuple, t: string, rawType?: string): string[] => {
  const type = isTupleType(t) ? t : rawType ?? item.toRawType();
  const commas = findTopLevelCommas(type);
  commas.push(-1);

  let start = 1;
  const types = [];

  for (const comma of commas) {
    types.push(type.slice(start, comma));
    start = comma + 1;
  }
  return types;
};
export const extractMapTypes = (
  item: CodecMap,
  t: string,
  rawType?: string
): { key: string; value: string } => {
  const type = isMapType(t) ? t : rawType ?? item.toRawType();
  let start = 0;
  if (type.startsWith('BTreeMap<')) {
    start = 9;
  } else if (type.startsWith('HashMap<')) {
    start = 8;
  } else {
    throw new Error(`Tried to decode ${item.toJSON()} as a Map, but it is not a map`);
  }

  const commaPosition = findTopLevelCommas(type, true)[0];

  const key = type.slice(start, commaPosition);
  const value = type.slice(commaPosition + 1, -1);
  return { key, value };
};
export const extractResultTypes = (
  item: Result<any, any>,
  t: string,
  rawType?: string
): { ok: string; err: string } => {
  const type = isResultType(t) ? t : rawType ?? item.toRawType();

  const commaPosition = findTopLevelCommas(type, true)[0];

  const ok = type.slice(7, commaPosition);
  const err = type.slice(commaPosition + 1, -1);
  return { ok, err };
};
// item.Type would return raw types
export const extractStructTypes = (
  item: Struct,
  t: string,
  rawType?: string
): { [name: string]: string } => {
  const type = isStructType(t) ? t : rawType ?? item.toRawType();
  return parseType(type);
};
// item.Type would return raw types
export const extractEnumType = (
  item: Enum,
  t: string,
  variant: string,
  rawType?: string
): string => {
  const type = isEnumType(t) ? t : rawType ?? item.toRawType();
  return parseType(type)._enum[variant];
};
