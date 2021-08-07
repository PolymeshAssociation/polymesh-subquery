import {
  SubstrateExtrinsic,
  SubstrateEvent,
  SubstrateBlock,
} from "@subql/types";
import { Block, Event, Extrinsic, Debug } from "../types";
import { inspect } from "util";
import { Balance, AccountId } from "@polkadot/types/interfaces";
import { GenericExtrinsic } from "@polkadot/types/extrinsic";
import { GenericLookupSource } from "@polkadot/types/";
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
import { Moment, Address } from "polymesh-subql/api-interfaces";
import BN from "bn.js";
import {
  u8aToHex,
  u8aToString,
  hexStripPrefix,
  hexToString,
} from "@polkadot/util";
import { decodeAddress } from "@polkadot/util-crypto";

export async function handleBlock(block: SubstrateBlock) {
  const header = block.block.header;
  const block_id = header.number.toNumber();

  let count_extrinsics_success = 0;

  for (const e of block.events) {
    if (e.event.method == "ExtrinsicSuccess") {
      count_extrinsics_success++;
    }
  }

  const { count_extrinsics_signed, count_extrinsics_unsigned } =
    processBlockExtrinsics(block.block.extrinsics);
  const count_extrinsics = block.block.extrinsics.length;

  await Block.create({
    id: `${block_id}`,
    parent_id: block_id - 1,
    hash: header.hash.toHex(),
    parent_hash: header.parentHash.toHex(),
    state_root: header.stateRoot.toHex(),
    extrinsics_root: header.extrinsicsRoot.toHex(),
    count_extrinsics,
    count_extrinsics_unsigned,
    count_extrinsics_signed,
    count_extrinsics_success,
    count_extrinsics_error: count_extrinsics - count_extrinsics_success,
    count_events: block.events.length,
    datetime: block.timestamp,
    spec_version_id: block.specVersion,
  }).save();
}

const processBlockExtrinsics = (
  extrinsics: Vec<GenericExtrinsic<AnyTuple>>
) => {
  const ret = {
    count_extrinsics_unsigned: 0,
    count_extrinsics_signed: 0,
  };
  for (const extrinsic of extrinsics) {
    if (extrinsic.isSigned) {
      ret.count_extrinsics_signed++;
    } else {
      ret.count_extrinsics_unsigned++;
    }
  }
  return ret;
};

export async function handleEvent(event: SubstrateEvent): Promise<void> {
  let block = event.block;
  const block_id = block.block.header.number.toNumber();
  const event_idx = event.idx;

  const args = event.event.data.toArray();
  try {
    const harvesterLikeArgs = args.map((arg, i) => ({
      value: deserializeLikeTheHarvester(
        arg,
        event.event.meta.args[i].toString()
      ),
    }));

    await Event.create({
      id: `${block_id}/${event_idx}`,
      block_id,
      event_idx,
      extrinsic_idx: event.extrinsic?.idx,
      spec_version_id: block.specVersion,
      module_id: event.event.section.toLowerCase(),
      event_id: event.event.method,
      attributes_txt: JSON.stringify(harvesterLikeArgs),
    }).save();
  } catch (error) {
    await Debug.create({
      id: JSON.stringify({
        block_id,
        args: args.map((a) => a.toJSON()),
        error: error.toString(),
        meta: event.event.meta,
      }),
    }).save();
  }
}
const fromEntries = <K, V, V2>(
  iterable: Iterable<[K, V]>,
  map: (v: V, i: number, k: K) => V2
) => {
  const res: any = {};

  let i = 0;
  for (const [k, v] of iterable) {
    res[k] = map(v, i, k);
    i++;
  }
  return res;
};
const parseType = (item: Codec) => {
  let type = item.toRawType();
  if (type.startsWith("{")) {
    return JSON.parse(type);
  } else {
    return undefined;
  }
};

const removeNullChars = (s: string) => s.replace(/\0/g, "");

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
// FIXME This does a very naive thing, it may well be ok for now but we should find a better way to do this.
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

const deserializeLikeTheHarvester = (
  item: Codec,
  type: string,
  isCallArg = false
): AnyJson => {
  if (typeof item !== "object") {
    return item;
  }

  const rawType = item.toRawType();

  Debug.create({
    id: JSON.stringify({
      rawType,
      type,
    }),
  }).save();

  // The filters have to be based on string comparisons because `item` can't be compared with `instanceof`
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
      call_args: harvesterLikeCallArgs(e),
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
      (v, i) => deserializeLikeTheHarvester(v, item.Types[i])
    );
  } else if (isArray(item)) {
    // item.Type === "Type" therefore string manipulation.
    const innerType = extractArrayType(item);
    return item.map((v) => deserializeLikeTheHarvester(v, innerType));
  } else if (isVec(item)) {
    // item.Type === "Type" therefore string manipulation.
    const innerType = extractVecType(item);
    return item.map((v) => deserializeLikeTheHarvester(v, innerType));
  } else if (isResult(item)) {
    const type = capitalizeFirstLetter(item.type);
    if (item.isOk) {
      return { Ok: deserializeLikeTheHarvester(item.value, type) };
    } else {
      // Harvester likes "Error" instead of "Err"
      return { Error: deserializeLikeTheHarvester(item.value, type) };
    }
  } else if (isEnum(item)) {
    const type = capitalizeFirstLetter(item.type);
    const valueType = extractEnumType(item, type);
    if (item.isBasic) {
      return type;
    } else {
      return {
        [type]: deserializeLikeTheHarvester(item.value, valueType),
      };
    }
  } else if (isStruct(item)) {
    const types = extractStructTypes(item);
    return fromEntries(item.entries(), (v, _, k) =>
      deserializeLikeTheHarvester(v, types[k])
    );
  } else if (isOption(item)) {
    return item.isSome
      ? deserializeLikeTheHarvester(item.value, extractOptionType(item))
      : null;
  } else if (isMap(item)) {
    // It is a BTreeMap or HashMap
    const { value } = extractMapTypes(item);
    // FIXME we might need to serialize the key too
    return fromEntries(item.entries(), (v) =>
      deserializeLikeTheHarvester(v, value)
    );
  } else {
    return item.toJSON();
  }
};
const harvesterLikeCallArgs = (extrinsic: GenericExtrinsic) => {
  const meta = extrinsic.meta.args;
  return extrinsic.args.map((arg, i) => ({
    name: meta[i].name.toString(),
    value: deserializeLikeTheHarvester(arg, meta[i].type.toString(), true),
  }));
};

export async function handleCall(extrinsic: SubstrateExtrinsic): Promise<void> {
  const block_id = extrinsic.block.block.header.number.toNumber();
  const extrinsic_idx = extrinsic.idx;

  await Extrinsic.create({
    id: `${block_id}/${extrinsic_idx}`,
    block_id,
    extrinsic_idx,
    extrinsic_hash: extrinsic.extrinsic.hash.toHex(),
    extrinsic_length: extrinsic.extrinsic.length,
    extrinsic_version: ("0" + extrinsic.extrinsic.version).slice(-2),
    signed: extrinsic.extrinsic.isSigned ? 1 : 0,
    address_length: extrinsic.extrinsic.signer.encodedLength,
    address: extrinsic.extrinsic.signer.toHex(),
    signature: extrinsic.extrinsic.signature.toHex(),
    nonce: extrinsic.extrinsic.nonce.toNumber(),
    era: extrinsic.extrinsic.era.toNumber(),
    module_id: extrinsic.extrinsic.method.section.toLowerCase(),
    call_id: camelToSnakeCase(extrinsic.extrinsic.method.method),
    params: JSON.stringify(harvesterLikeCallArgs(extrinsic.extrinsic)),
    success: extrinsic.success ? 1 : 0,
    spec_version_id: extrinsic.block.specVersion,
  }).save();
}
const camelToSnakeCase = (str: string) =>
  str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const capitalizeFirstLetter = (str: string) =>
  str[0].toUpperCase() + str.slice(1);
