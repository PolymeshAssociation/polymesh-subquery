import { GenericExtrinsic } from "@polkadot/types/extrinsic";
import { capitalizeFirstLetter, fromEntries, removeNullChars } from "./util";
import {
  Enum,
  Option,
  Vec,
  Compact,
  Struct,
  Tuple,
  Result,
  VecFixed,
} from "@polkadot/types/codec";
import { CodecMap } from "@polkadot/types/codec/Map";
import { TextDecoder } from "util";
import { AnyTuple, Codec, AnyJson } from "@polkadot/types/types";
import { Moment } from "polymesh-subql/api-interfaces";
import BN from "bn.js";
import { FoundType } from "../types";
import {
  u8aToHex,
  u8aToString,
  hexStripPrefix,
  hexToString,
} from "@polkadot/util";
import { decodeAddress } from "@polkadot/util-crypto";

/**
 * @returns A json representation of `item` serialized using the same rules as the harvester.
 * @param item The Codec to be deserialized.
 * @param type The actual type (as opposed to raw type) of item
 * @param isCallArg true if item is an argument in a Call (the harvester deserializes LookupSources differently based on this)
 */
export const serializeLikeHarvester = (
  item: Codec,
  type: string,
  isCallArg = false
): AnyJson => {
  if (typeof item !== "object") {
    return item;
  }

  const rawType = item.toRawType();

  FoundType.create({
    id: type,
    rawType,
  }).save();

  // The filters have to be based on string comparisons because `item` does not have the right prototype chain to be comparable using `instanceof`.
  //
  // I have decided to keep all harvester special cases in one file to make it easy to keep track of them, this might seem "ugly" but the alternative
  // of keeping each one in it's own file makes it much more cumbersome to search through them.
  if (rawType === "Compact<Moment>") {
    const isoParts = new Date((item as Compact<Moment>).toNumber())
      .toISOString()
      .slice(0, -1) // remove Z
      .split(".");
    if (parseInt(isoParts[1])) {
      isoParts[1] = (isoParts[1] + "000000").slice(0, 6); // the harvester likes 6 digits of precision but only when it is not 0 ¯\_(ツ)_/¯
      return isoParts.join(".");
    } else {
      return isoParts[0];
    }
  } else if (rawType === "AccountId") {
    return item.toHex();
  } else if (rawType === "()") {
    return null;
  } else if (type == "HexBytes") {
    return item.toHuman();
  } else if (rawType === "Bytes") {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      return removeNullChars(
        decoder.decode(Buffer.from(hexStripPrefix(item.toString()), "hex"))
      );
    } catch {
      return item.toJSON();
    }
  } else if (type === "OpaqueMultiaddr") {
    return hexToString(item.toString());
  } else if (rawType === "Text") {
    return removeNullChars(item.toString());
  } else if (type === "Ticker") {
    return removeNullChars(u8aToString(item.toU8a()));
  } else if (rawType === "Call") {
    let e = item as unknown as GenericExtrinsic;
    return {
      call_index: hexStripPrefix(u8aToHex(e.callIndex)),
      call_function: e.method.method,
      call_module: e.method.section,
      call_args: serializeCallArgsLikeHarvester(e),
    };
  } else if (isCallArg && type === "Vec<LookupSource>") {
    return (item as Vec<any>).map((i) =>
      hexStripPrefix(
        u8aToHex(decodeAddress(i.toString(), false, item.registry.chainSS58))
      )
    );
  } else if (type === "LookupSource") {
    return u8aToHex(
      decodeAddress(item.toString(), false, item.registry.chainSS58)
    );
  } else if (type === "Balance") {
    return parseInt(item.toString()); // This might not work for big numbers but it's the way the harvester does it.
  } else if (type === "ElectionScore") {
    return (item as unknown as BN[]).map((n) => parseInt(n.toString())); // This might not work for big numbers but that's the way the harvester does it.
  } else if (isTuple(item)) {
    return fromEntries(
      (item as unknown as AnyTuple).map((v, i) => [`col${i + 1}`, v]),
      (v, i) => serializeLikeHarvester(v, item.Types[i])
    );
  } else if (isArray(item)) {
    // item.Type === "Type" therefore string manipulation.
    const innerType = extractArrayType(item);
    return item.map((v) => serializeLikeHarvester(v, innerType));
  } else if (isVec(item)) {
    // item.Type === "Type" therefore string manipulation.
    const innerType = extractVecType(item);
    return item.map((v) => serializeLikeHarvester(v, innerType));
  } else if (isResult(item)) {
    const type = capitalizeFirstLetter(item.type);
    if (item.isOk) {
      return { Ok: serializeLikeHarvester(item.value, type) };
    } else {
      // Harvester likes "Error" instead of "Err"
      return { Error: serializeLikeHarvester(item.value, type) };
    }
  } else if (isEnum(item)) {
    const type = capitalizeFirstLetter(item.type);
    const valueType = extractEnumType(item, type);
    if (item.isBasic) {
      return type;
    } else {
      return {
        [type]: serializeLikeHarvester(item.value, valueType),
      };
    }
  } else if (isStruct(item)) {
    const types = extractStructTypes(item);
    return fromEntries(item.entries(), (v, _, k) =>
      serializeLikeHarvester(v, types[k])
    );
  } else if (isOption(item)) {
    return item.isSome
      ? serializeLikeHarvester(item.value, extractOptionType(item))
      : null;
  } else if (isMap(item)) {
    // It is a BTreeMap or HashMap
    const { value } = extractMapTypes(item);
    return fromEntries(item.entries(), (v) => serializeLikeHarvester(v, value));
  } else {
    return item.toJSON();
  }
};

export const serializeCallArgsLikeHarvester = (extrinsic: GenericExtrinsic) => {
  const meta = extrinsic.meta.args;
  return extrinsic.args.map((arg, i) => ({
    name: meta[i].name.toString(),
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
const parseType = (item: Codec) => {
  let type = item.toRawType();
  if (type.startsWith("{")) {
    return JSON.parse(type);
  } else {
    return undefined;
  }
};

const isTuple = (item: Codec): item is Tuple => {
  const type = item.toRawType();
  return type.length > 2 && type.startsWith("(") && type.endsWith(")");
};
const isVec = (item: Codec): item is Vec<any> => {
  const type = item.toRawType();
  return type.startsWith("Vec<");
};
const isArray = (item: Codec): item is VecFixed<any> => {
  const type = item.toRawType();
  return type.startsWith("[") && type.endsWith("]");
};
const isOption = (item: Codec): item is Option<any> => {
  const type = item.toRawType();
  return type.startsWith("Option<");
};
const isResult = (item: Codec): item is Result<any, any> => {
  const type = item.toRawType();
  return type.startsWith("Result<");
};
const extractOptionType = (item: Option<any>) => {
  const type = item.toRawType();
  return type.slice(7, -1);
};
const extractVecType = (item: Vec<any>) => {
  const type = item.toRawType();
  return type.slice(4, -1);
};
const extractArrayType = (item: VecFixed<any>) => {
  const type = item.toRawType();
  return type.slice(1, type.lastIndexOf(";"));
};
const isMap = (item: Codec): item is CodecMap<any> => {
  const type = item.toRawType();
  return type.startsWith("BTreeMap<") || type.startsWith("HashMap<");
};

// FIXME This does not support nested generics or tuples since it can't differentiate if a comma is at the top level
// or in a nested type, a cleverer algorithm needs to be implemented.
const extractMapTypes = (item: CodecMap): { key: string; value: string } => {
  const type = item.toRawType();
  let start = 0;
  if (type.startsWith("BTreeMap<")) start = 9;
  else if (type.startsWith("HashMap<")) {
    start = 8;
  } else {
    throw new Error(
      `Tried to decode ${item.toJSON()} as a Map, but it is not a map`
    );
  }
  const [key, value] = type.slice(start, -1).split(",");
  return { key, value };
};
const isEnum = (item: Codec): item is Enum => {
  const parsedType = parseType(item);
  return parsedType?._enum !== undefined;
};
const isStruct = (item: Codec): item is Struct => {
  const parsedType = parseType(item);
  return parsedType && parsedType._enum === undefined;
};

// item.Type would return raw types
const extractStructTypes = (item: Struct): { [name: string]: string } => {
  const parsedType = parseType(item);
  return parsedType;
};
// item.Type would return raw types
const extractEnumType = (item: Enum, type: string): string => {
  const parsedType = parseType(item);
  return parsedType._enum[type];
};
