import { Vec } from "@polkadot/types/codec";
import { GenericExtrinsic } from "@polkadot/types/extrinsic";
import { AnyTuple, Codec } from "@polkadot/types/types";
import { hexStripPrefix, u8aToHex } from "@polkadot/util";
import { decodeAddress } from "@polkadot/util-crypto";
import {
  SubstrateBlock,
  SubstrateEvent,
  SubstrateExtrinsic,
} from "@subql/types";
import { Block, Event, Extrinsic, FoundType } from "../types";
import { EventIdEnum, ModuleIdEnum } from "./entities/common";
import { mapAuthorization } from "./entities/mapAuthorization";
import { mapCorporateActions } from "./entities/mapCorporateActions";
import { mapExternalAgentAction } from "./entities/mapExternalAgentAction";
import { mapFunding } from "./entities/mapFunding";
import { mapInvestment } from "./entities/mapInvestment";
import { mapStakingEvent } from "./entities/mapStakingEvent";
import { mapSto } from "./entities/mapSto";
import {
  extractClaimInfo,
  extractCorporateActionTicker,
  extractEventArgs,
  extractOfferingAsset,
  extractTransferTo,
} from "./generatedColumns";
import {
  serializeCallArgsLikeHarvester,
  serializeLikeHarvester,
} from "./serializeLikeHarvester";
import { camelToSnakeCase } from "./util";
import { mapSettlement } from "./entities/mapSettlement";

export async function handleBlock(block: SubstrateBlock): Promise<void> {
  const header = block.block.header;
  const blockId = header.number.toNumber();

  let countExtrinsicsSuccess = 0;

  for (const e of block.events) {
    if (e.event.method == "ExtrinsicSuccess") {
      countExtrinsicsSuccess++;
    }
  }

  const { countExtrinsicsSigned, countExtrinsicsUnsigned } =
    processBlockExtrinsics(block.block.extrinsics);
  const countExtrinsics = block.block.extrinsics.length;

  await Block.create({
    id: `${blockId}`,
    blockId,
    parentId: blockId - 1,
    hash: header.hash.toHex(),
    parentHash: header.parentHash.toHex(),
    stateRoot: header.stateRoot.toHex(),
    extrinsicsRoot: header.extrinsicsRoot.toHex(),
    countExtrinsics,
    countExtrinsicsUnsigned,
    countExtrinsicsSigned,
    countExtrinsicsSuccess,
    countExtrinsicsError: countExtrinsics - countExtrinsicsSuccess,
    countEvents: block.events.length,
    datetime: block.timestamp,
    specVersionId: block.specVersion,
  }).save();
}

const logFoundType = (type: string, rawType: string) => {
  FoundType.create({ id: type, rawType }).save();
};

const processBlockExtrinsics = (
  extrinsics: Vec<GenericExtrinsic<AnyTuple>>
) => {
  const ret = {
    countExtrinsicsUnsigned: 0,
    countExtrinsicsSigned: 0,
  };
  for (const extrinsic of extrinsics) {
    if (extrinsic.isSigned) {
      ret.countExtrinsicsSigned++;
    } else {
      ret.countExtrinsicsUnsigned++;
    }
  }
  return ret;
};

export async function handleEvent(event: SubstrateEvent): Promise<void> {
  const block = event.block;
  const blockId = block.block.header.number.toNumber();
  const eventIdx = event.idx;

  const moduleId = event.event.section.toLowerCase();
  const eventId = event.event.method;

  const args = event.event.data.toArray();

  const handlerArgs: [
    number,
    EventIdEnum,
    ModuleIdEnum,
    Codec[],
    SubstrateEvent
  ] = [blockId, eventId as EventIdEnum, moduleId as ModuleIdEnum, args, event];
  const handlerPromises = [
    mapStakingEvent(...handlerArgs),
    mapSto(eventId, moduleId, args),
    mapExternalAgentAction(...handlerArgs),
    mapFunding(...handlerArgs),
    mapAuthorization(
      blockId,
      eventId as EventIdEnum,
      moduleId as ModuleIdEnum,
      args
    ),
    mapInvestment(...handlerArgs),
    mapSettlement(...handlerArgs),
    mapCorporateActions(...handlerArgs),
  ];

  const harvesterLikeArgs = args.map((arg, i) => ({
    value: serializeLikeHarvester(
      arg,
      event.event.meta.args[i].toString(),
      logFoundType
    ),
  }));
  const { eventArg_0, eventArg_1, eventArg_2, eventArg_3 } =
    extractEventArgs(harvesterLikeArgs);
  const { claimExpiry, claimIssuer, claimScope, claimType } =
    extractClaimInfo(harvesterLikeArgs);

  await Event.create({
    id: `${blockId}/${eventIdx}`,
    blockId,
    eventIdx,
    extrinsicIdx: event.extrinsic?.idx,
    specVersionId: block.specVersion,
    eventId,
    moduleId,
    attributesTxt: JSON.stringify(harvesterLikeArgs),
    eventArg_0,
    eventArg_1,
    eventArg_2,
    eventArg_3,
    claimType,
    claimExpiry,
    claimIssuer,
    claimScope,
    corporateActionTicker: extractCorporateActionTicker(harvesterLikeArgs),
    fundraiserOfferingAsset: extractOfferingAsset(harvesterLikeArgs),
    transferTo: extractTransferTo(harvesterLikeArgs),
  }).save();

  await Promise.all(handlerPromises).catch((err) => {
    logger.error(err);
  });
}

export async function handleCall(extrinsic: SubstrateExtrinsic): Promise<void> {
  const blockId = extrinsic.block.block.header.number.toNumber();
  const extrinsicIdx = extrinsic.idx;
  const signedbyAddress = !extrinsic.extrinsic.signer.isEmpty;
  const address = signedbyAddress
    ? hexStripPrefix(
        u8aToHex(
          decodeAddress(
            extrinsic.extrinsic.signer.toString(),
            false,
            extrinsic.extrinsic.registry.chainSS58
          )
        )
      )
    : null;

  await Extrinsic.create({
    id: `${blockId}/${extrinsicIdx}`,
    blockId,
    extrinsicIdx,
    extrinsicLength: extrinsic.extrinsic.length,
    signed: extrinsic.extrinsic.isSigned ? 1 : 0,
    moduleId: extrinsic.extrinsic.method.section.toLowerCase(),
    callId: camelToSnakeCase(extrinsic.extrinsic.method.method),
    paramsTxt: JSON.stringify(
      serializeCallArgsLikeHarvester(extrinsic.extrinsic, logFoundType)
    ),
    success: extrinsic.success ? 1 : 0,
    signedbyAddress: signedbyAddress ? 1 : 0,
    address,
    nonce: extrinsic.extrinsic.nonce.toJSON(),
    extrinsicHash: hexStripPrefix(extrinsic.extrinsic.hash.toJSON()),
    specVersionId: extrinsic.block.specVersion,
  }).save();
}
