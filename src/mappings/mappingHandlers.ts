import {
  SubstrateExtrinsic,
  SubstrateEvent,
  SubstrateBlock,
} from "@subql/types";
import { Block, Event, Extrinsic, Debug } from "../types";
import { GenericExtrinsic } from "@polkadot/types/extrinsic";
import { Vec } from "@polkadot/types/codec";
import { AnyTuple } from "@polkadot/types/types";
import { camelToSnakeCase } from "./util";
import {
  serializeLikeHarvester,
  serializeCallArgsLikeHarvester,
} from "./serializeLikeHarvester";

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
    block_id,
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

// These functions are the equivalent of the ColumnsAndIndeces.sql in the harvester.
// Since we need to index on them, storing them directly through subquery results in
// more readable code than relying on generated columns or materialized views and has
// the same storage overhead.

const extractEventArg = (arg: any) => {
  if (arg !== undefined) {
    if (typeof arg?.value !== "string") {
      return JSON.stringify(arg?.value);
    } else {
      return arg?.value;
    }
  } else {
    return null;
  }
};

const extractEventArgs = ([arg0, arg1, arg2, arg3]: any[]) => {
  return {
    event_arg_0: extractEventArg(arg0),
    event_arg_1: extractEventArg(arg1),
    event_arg_2: extractEventArg(arg2),
    event_arg_3: extractEventArg(arg3),
  };
};

const extractClaimScope = (claim_type: string, args: any[]) => {
  switch (claim_type) {
    case "CustomerDueDiligence": {
      return null;
    }
    case "InvestorUniqueness": {
      const scope = args[1]?.value?.claim?.InvestorUniqueness?.col1;
      const type = Object.keys(scope || {})?.[0];
      const value = scope?.[type];
      return { type, value };
    }
    case "Jurisdiction": {
      const scope = args[1]?.value?.claim?.InvestorUniqueness?.col2;
      const type = Object.keys(scope || {})?.[0];
      const value = scope?.[type];
      return { type, value };
    }
    default: {
      const scope = args[1]?.value?.claim?.[claim_type];
      const type = Object.keys(scope || {})?.[0];
      const value = scope?.[type];
      return { type, value };
    }
  }
};

const extractClaimInfo = (args: any[]) => {
  const claim_type: string | undefined = Object.keys(
    args?.[1]?.value?.claim || {}
  )[0];

  return {
    claim_type,
    claim_scope: JSON.stringify(extractClaimScope(claim_type, args)),
    claim_issuer: JSON.stringify(args[1]?.value?.claim_issuer),
    claim_expiry: JSON.stringify(args[1]?.value?.expiry),
  };
};

const extractCorporateActionTicker = (args: any[]) => {
  const valueTicker = args[1]?.value?.ticker;
  if (valueTicker !== undefined) {
    return valueTicker;
  }
  const valueOfferingAsset = args[3]?.value?.offering_asset;
  if (valueOfferingAsset !== undefined) {
    return valueOfferingAsset;
  }
  return null;
};

const extractOfferingAsset = (args: any[]) => args[3]?.value?.offering_asset;

export async function handleEvent(event: SubstrateEvent): Promise<void> {
  let block = event.block;
  const block_id = block.block.header.number.toNumber();
  const event_idx = event.idx;

  const args = event.event.data.toArray();
  const harvesterLikeArgs = args.map((arg, i) => ({
    value: serializeLikeHarvester(arg, event.event.meta.args[i].toString()),
  }));
  const { event_arg_0, event_arg_1, event_arg_2, event_arg_3 } =
    extractEventArgs(harvesterLikeArgs);
  const { claim_expiry, claim_issuer, claim_scope, claim_type } =
    extractClaimInfo(harvesterLikeArgs);

  await Event.create({
    id: `${block_id}/${event_idx}`,
    block_id,
    event_idx,
    extrinsic_idx: event.extrinsic?.idx,
    spec_version_id: block.specVersion,
    module_id: event.event.section.toLowerCase(),
    event_id: event.event.method,
    attributes_txt: JSON.stringify(harvesterLikeArgs),
    event_arg_0,
    event_arg_1,
    event_arg_2,
    event_arg_3,
    claim_type,
    claim_expiry,
    claim_issuer,
    claim_scope,
    corporate_action_ticker: extractCorporateActionTicker(harvesterLikeArgs),
    fundraiser_offering_asset: extractOfferingAsset(harvesterLikeArgs),
  }).save();
}

export async function handleCall(extrinsic: SubstrateExtrinsic): Promise<void> {
  const block_id = extrinsic.block.block.header.number.toNumber();
  const extrinsic_idx = extrinsic.idx;

  await Extrinsic.create({
    id: `${block_id}/${extrinsic_idx}`,
    block_id,
    extrinsic_idx,
    extrinsic_length: extrinsic.extrinsic.length,
    signed: extrinsic.extrinsic.isSigned ? 1 : 0,
    module_id: extrinsic.extrinsic.method.section.toLowerCase(),
    call_id: camelToSnakeCase(extrinsic.extrinsic.method.method),
    params_txt: JSON.stringify(
      serializeCallArgsLikeHarvester(extrinsic.extrinsic)
    ),
    success: extrinsic.success ? 1 : 0,
    spec_version_id: extrinsic.block.specVersion,
  }).save();
}
