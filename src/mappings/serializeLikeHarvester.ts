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

  const rawType = item.toRawType();

  // The filters have to be based on string comparisons because `item` does not have the right prototype chain to be comparable using `instanceof`.
  //
  // I have decided to keep all harvester special cases in one file to make it easy to keep track of them, this might seem "ugly" but the alternative
  // of keeping each one in it's own file makes it much more cumbersome to search through them.
  if (rawType === 'Compact<Moment>') {
    const isoParts = new Date((item as Compact<u64>).toNumber())
      .toISOString()
      .slice(0, -1) // remove Z
      .split('.');
    if (parseInt(isoParts[1])) {
      isoParts[1] = (isoParts[1] + '000000').slice(0, 6); // the harvester likes 6 digits of precision but only when it is not 0 ¯\_(ツ)_/¯
      return isoParts.join('.');
    } else {
      return isoParts[0];
    }
  } else if (rawType === 'AccountId') {
    return item.toHex();
  } else if (rawType === '()') {
    return null;
  } else if (type == 'HexBytes') {
    return item.toJSON();
  } else if (rawType === 'Bytes') {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      return removeNullChars(decoder.decode(Buffer.from(hexStripPrefix(item.toString()), 'hex')));
    } catch {
      return item.toJSON();
    }
  } else if (rawType === 'Text') {
    return removeNullChars(item.toString());
  } else if (type === 'Ticker' || type === 'PolymeshPrimitivesTicker') {
    return serializeTicker(item);
  } else if (rawType.startsWith('[u8;') && rawType.endsWith(']')) {
    return item.toHex();
  } else if (rawType === 'Call') {
    const e = item as unknown as GenericCall;
    let hexCallIndex;
    if (e.callIndex instanceof Uint8Array) {
      hexCallIndex = u8aToHex(e.callIndex);
    } else {
      hexCallIndex = e.getT('callIndex').toString();
    }
    return {
      call_index: hexStripPrefix(hexCallIndex),
      call_function: camelToSnakeCase(e.method),
      call_module: capitalizeFirstLetter(e.section),
      call_args: serializeCallArgsLikeHarvester(e),
    };
  } else if (isCallArg && type === 'Vec<LookupSource>') {
    return (item as Vec<any>).map(i =>
      hexStripPrefix(u8aToHex(decodeAddress(i.toString(), false, item.registry.chainSS58)))
    );
  } else if (type === 'LookupSource') {
    return u8aToHex(decodeAddress(item.toString(), false, item.registry.chainSS58));
  } else if (type === 'Balance') {
    return parseInt(item.toString()); // This might not work for big numbers but it's the way the harvester does it.
  } else if (type === 'ElectionScore') {
    // In newer Substrate versions ElectionScore became a named struct (SpNposElectionsElectionScore)
    // rather than a plain tuple/array of BN values. Fall back to the struct serializer in that case.
    if (isStructType(rawType)) {
      const types = extractStructTypes(item as unknown as Struct, rawType);
      return fromEntries((item as unknown as Struct).entries(), (v, _, k) =>
        serializeLikeHarvester(v, types[k])
      );
    }
    return (item as unknown as BN[]).map(n => parseInt(n.toString())); // This might not work for big numbers but that's the way the harvester does it.
  }

  // Each test reads the raw type computed above. The `isX(item)` helpers recompute it, and a
  // struct's or call's raw type is rebuilt from the registry every time, so testing through them
  // described a value 8-10 times over and parsed it several.
  if (isTupleType(rawType)) {
    const types = extractTupleTypes(item as unknown as Tuple, type, rawType);
    return fromEntries(
      (item as unknown as AnyTuple).map((v, i) => [`col${i + 1}`, v]),
      (v, i) => serializeLikeHarvester(v, types[i])
    );
  } else if (isArrayType(rawType)) {
    // item.Type === "Type" therefore string manipulation.
    const array = item as unknown as VecFixed<any>;
    const innerType = extractArrayType(array, type, rawType);
    return array.map(v => serializeLikeHarvester(v, innerType));
  } else if (isVecType(rawType)) {
    // item.Type === "Type" therefore string manipulation.
    const vec = item as unknown as Vec<any>;
    const innerType = extractVecType(vec, type, rawType);
    return vec.map(v => serializeLikeHarvester(v, innerType));
  } else if (isResultType(rawType)) {
    const result = item as unknown as Result<any, any>;
    const types = extractResultTypes(result, type, rawType);
    if (result.isOk) {
      return { Ok: serializeLikeHarvester(result.value, types.ok) };
    } else {
      // Harvester likes "Error" instead of "Err"
      return {
        Error: serializeLikeHarvester(result.value, types.err),
      };
    }
  } else if (isEnumType(rawType)) {
    const enumItem = item as unknown as Enum;
    const variant = capitalizeFirstLetter(enumItem.type);
    const valueType = extractEnumType(enumItem, type, variant, rawType);
    if (enumItem.isBasic) {
      return variant;
    } else {
      return {
        [variant]: serializeLikeHarvester(enumItem.value, valueType),
      };
    }
  } else if (isStructType(rawType)) {
    const struct = item as unknown as Struct;
    const types = extractStructTypes(struct, type, rawType);
    return fromEntries(struct.entries(), (v, _, k) => serializeLikeHarvester(v, types[k]));
  } else if (isOptionType(rawType)) {
    const option = item as unknown as Option<any>;
    return option.isSome
      ? serializeLikeHarvester(option.value, extractOptionType(option, type, rawType))
      : null;
  } else if (isMapType(rawType)) {
    // It is a BTreeMap or HashMap
    const map = item as unknown as CodecMap<any>;
    const { value } = extractMapTypes(map, type, rawType);
    return fromEntries(map.entries(), v => serializeLikeHarvester(v, value));
  } else {
    return item.toJSON();
  }
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
