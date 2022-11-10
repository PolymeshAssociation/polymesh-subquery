import { GenericCall, GenericExtrinsic, u64 } from '@polkadot/types';
import {
  camelToSnakeCase,
  capitalizeFirstLetter,
  findTopLevelCommas,
  fromEntries,
  removeNullChars,
  serializeTicker,
} from './util';
import {
  Enum,
  Option,
  Vec,
  Compact,
  Struct,
  Tuple,
  Result,
  VecFixed,
  CodecMap,
} from '@polkadot/types/codec';
import { TextDecoder } from 'util';
import { AnyTuple, Codec, AnyJson } from '@polkadot/types/types';
import BN from 'bn.js';
import { u8aToHex, hexStripPrefix } from '@polkadot/util';
import { decodeAddress } from '@polkadot/util-crypto';

/**
 * @returns A json representation of `item` serialized using the same rules as the harvester.
 * @param item The Codec to be deserialized.
 * @param type The actual type (as opposed to raw type) of item
 * @param isCallArg true if item is an argument in a Call (the harvester deserializes LookupSources differently based on this)
 */
export const serializeLikeHarvester = (
  item: Codec,
  type: string,
  logFoundType: (type: string, rawType: string) => void,
  isCallArg = false
): AnyJson => {
  if (typeof item !== 'object') {
    return item;
  }

  const rawType = item.toRawType();

  logFoundType(type, rawType);

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
      call_args: serializeCallArgsLikeHarvester(e, logFoundType),
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
    return (item as unknown as BN[]).map(n => parseInt(n.toString())); // This might not work for big numbers but that's the way the harvester does it.
  } else if (isTuple(item)) {
    const types = extractTupleTypes(item, type);
    return fromEntries(
      (item as unknown as AnyTuple).map((v, i) => [`col${i + 1}`, v]),
      (v, i) => serializeLikeHarvester(v, types[i], logFoundType)
    );
  } else if (isArray(item)) {
    // item.Type === "Type" therefore string manipulation.
    const innerType = extractArrayType(item, type);
    return item.map(v => serializeLikeHarvester(v, innerType, logFoundType));
  } else if (isVec(item)) {
    // item.Type === "Type" therefore string manipulation.
    const innerType = extractVecType(item, type);
    return item.map(v => serializeLikeHarvester(v, innerType, logFoundType));
  } else if (isResult(item)) {
    const types = extractResultTypes(item, type);
    if (item.isOk) {
      return { Ok: serializeLikeHarvester(item.value, types.ok, logFoundType) };
    } else {
      // Harvester likes "Error" instead of "Err"
      return {
        Error: serializeLikeHarvester(item.value, types.err, logFoundType),
      };
    }
  } else if (isEnum(item)) {
    const variant = capitalizeFirstLetter(item.type);
    const valueType = extractEnumType(item, type, variant);
    if (item.isBasic) {
      return variant;
    } else {
      return {
        [variant]: serializeLikeHarvester(item.value, valueType, logFoundType),
      };
    }
  } else if (isStruct(item)) {
    const types = extractStructTypes(item, type);
    return fromEntries(item.entries(), (v, _, k) =>
      serializeLikeHarvester(v, types[k], logFoundType)
    );
  } else if (isOption(item)) {
    return item.isSome
      ? serializeLikeHarvester(item.value, extractOptionType(item, type), logFoundType)
      : null;
  } else if (isMap(item)) {
    // It is a BTreeMap or HashMap
    const { value } = extractMapTypes(item, type);
    return fromEntries(item.entries(), v => serializeLikeHarvester(v, value, logFoundType));
  } else {
    return item.toJSON();
  }
};

export type HarvesterLikeCallArgs = { name: string; value: any }[];

export const serializeCallArgsLikeHarvester = (
  extrinsic: GenericCall | GenericExtrinsic,
  logFoundType: (type: string, rawType: string) => void
): HarvesterLikeCallArgs => {
  const meta = extrinsic.meta.args;
  return extrinsic.args.map((arg, i) => ({
    name: camelToSnakeCase(meta[i].name.toString()),
    value: serializeLikeHarvester(arg, meta[i].type.toString(), logFoundType, true),
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
export const parseType = (type: string): any => {
  if (type.startsWith('{')) {
    return JSON.parse(type);
  } else {
    return undefined;
  }
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

export const extractOptionType = (item: Option<any>, t: string): string => {
  const type = isOptionType(t) ? t : item.toRawType();
  return type.slice(7, -1);
};
export const extractVecType = (item: Vec<any>, t: string): string => {
  const type = isVecType(t) ? t : item.toRawType();
  return type.slice(4, -1);
};
export const extractArrayType = (item: VecFixed<any>, t: string): string => {
  const type = isArrayType(t) ? t : item.toRawType();
  return type.slice(1, type.lastIndexOf(';'));
};
export const extractTupleTypes = (item: Tuple, t: string): string[] => {
  const type = isTupleType(t) ? t : item.toRawType();
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
export const extractMapTypes = (item: CodecMap, t: string): { key: string; value: string } => {
  const type = isMapType(t) ? t : item.toRawType();
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
  t: string
): { ok: string; err: string } => {
  const type = isResultType(t) ? t : item.toRawType();

  const commaPosition = findTopLevelCommas(type, true)[0];

  const ok = type.slice(7, commaPosition);
  const err = type.slice(commaPosition + 1, -1);
  return { ok, err };
};
// item.Type would return raw types
export const extractStructTypes = (item: Struct, t: string): { [name: string]: string } => {
  const type = isStructType(t) ? t : item.toRawType();
  return parseType(type);
};
// item.Type would return raw types
export const extractEnumType = (item: Enum, t: string, variant: string): string => {
  const type = isEnumType(t) ? t : item.toRawType();
  return parseType(type)._enum[variant];
};
