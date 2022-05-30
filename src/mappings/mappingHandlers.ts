import { Vec } from '@polkadot/types/codec';
import { GenericExtrinsic } from '@polkadot/types/extrinsic';
import { AnyTuple, Codec } from '@polkadot/types/types';
import { hexStripPrefix, u8aToHex } from '@polkadot/util';
import { decodeAddress } from '@polkadot/util-crypto';
import { SubstrateBlock, SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import { Block, Event, Extrinsic } from '../types';
import { EventIdEnum, ModuleIdEnum } from './entities/common';
import { mapClaim } from './entities/mapClaim';
import { mapIdentities } from './entities/mapIdentities';
import {
  extractClaimInfo,
  extractCorporateActionTicker,
  extractEventArgs,
  extractOfferingAsset,
  extractTransferTo,
} from './generatedColumns';
import { serializeCallArgsLikeHarvester, serializeLikeHarvester } from './serializeLikeHarvester';
import { camelToSnakeCase, harvesterLikeParamsToObj, logFoundType } from './util';

export async function handleBlock(block: SubstrateBlock): Promise<void> {
  const header = block.block.header;
  const blockId = header.number.toNumber();
  let countExtrinsicsSuccess = 0;

  for (const e of block.events) {
    if (e.event.method == 'ExtrinsicSuccess') {
      countExtrinsicsSuccess++;
    }
  }

  const { countExtrinsicsSigned, countExtrinsicsUnsigned } = processBlockExtrinsics(
    block.block.extrinsics
  );
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

const processBlockExtrinsics = (extrinsics: Vec<GenericExtrinsic<AnyTuple>>) => {
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

export async function handleToolingEvent(event: SubstrateEvent): Promise<void> {
  const block = event.block;
  const blockId = block.block.header.number.toString();
  const eventIdx = event.idx;
  const moduleId = event.event.section.toLowerCase();
  const eventId = event.event.method;
  const args = event.event.data.toArray();

  const harvesterLikeArgs = args.map((arg, i) => ({
    value: serializeLikeHarvester(arg, event.event.meta.args[i].toString(), logFoundType),
  }));
  const { eventArg_0, eventArg_1, eventArg_2, eventArg_3 } = extractEventArgs(harvesterLikeArgs);

  const { claimExpiry, claimIssuer, claimScope, claimType } = extractClaimInfo(harvesterLikeArgs);

  await Event.create({
    id: `${blockId}/${eventIdx}`,
    blockId,
    eventIdx,
    extrinsicIdx: event?.extrinsic?.idx,
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
}

export async function handleToolingCall(extrinsic: SubstrateExtrinsic): Promise<void> {
  const { blockId, extrinsicIdx, signedbyAddress, address, params } = getCallArgs(extrinsic);

  await Extrinsic.create({
    id: `${blockId}/${extrinsicIdx}`,
    blockId,
    extrinsicIdx,
    extrinsicLength: extrinsic.extrinsic.length,
    signed: extrinsic.extrinsic.isSigned ? 1 : 0,
    moduleId: extrinsic.extrinsic.method.section.toLowerCase(),
    callId: camelToSnakeCase(extrinsic.extrinsic.method.method),
    paramsTxt: JSON.stringify(params),
    success: extrinsic.success ? 1 : 0,
    signedbyAddress: signedbyAddress ? 1 : 0,
    address,
    nonce: extrinsic.extrinsic.nonce.toNumber(),
    extrinsicHash: hexStripPrefix(extrinsic.extrinsic.hash.toJSON()),
    specVersionId: extrinsic.block.specVersion,
  }).save();
}

// handles an event to populate native GraphQL tables as well as what is needed for tooling
export async function handleEvent(event: SubstrateEvent): Promise<void> {
  await handleToolingEvent(event);

  const block = event.block;
  const blockId = block.block.header.number.toString();
  const moduleId = event.event.section.toLowerCase();
  const eventId = event.event.method;
  const args = event.event.data.toArray();

  const handlerArgs: [string, EventIdEnum, ModuleIdEnum, Codec[], SubstrateEvent] = [
    blockId,
    eventId as EventIdEnum,
    moduleId as ModuleIdEnum,
    args,
    event,
  ];
  const handlerPromises = [
    mapIdentities(...handlerArgs),
    // TODO @prashantasdeveloper remove the commented out code

    // mapStakingEvent(...handlerArgs),
    // mapBridgeEvent(...handlerArgs),
    // mapSto(eventId, moduleId, args),
    // mapExternalAgentAction(...handlerArgs),
    // mapTickerExternalAgentAdded(...handlerArgs),
    // mapTickerExternalAgentHistory(...handlerArgs),
    // mapFunding(...handlerArgs),
    // mapAuthorization(blockId, eventId as EventIdEnum, moduleId as ModuleIdEnum, args),
    // mapInvestment(...handlerArgs),
    // mapSettlement(...handlerArgs),
    // mapCorporateActions(...handlerArgs),
    // mapProposal(...handlerArgs),
    // mapTrustedClaimIssuerTicker(...handlerArgs),
    // mapHeldTokens(eventId as EventIdEnum, moduleId as ModuleIdEnum, args),
  ];

  const harvesterLikeArgs = args.map((arg, i) => ({
    value: serializeLikeHarvester(arg, event.event.meta.args[i].toString(), logFoundType),
  }));

  const {
    claimExpiry,
    claimIssuer,
    claimScope,
    claimType,
    issuanceDate,
    lastUpdateDate,
    cddId,
    jurisdiction,
  } = extractClaimInfo(harvesterLikeArgs);

  handlerPromises.push(
    mapClaim(...handlerArgs, {
      claimExpiry,
      claimIssuer,
      claimScope,
      claimType,
      issuanceDate,
      lastUpdateDate,
      cddId,
      jurisdiction,
    })
  );

  await Promise.all(handlerPromises);
}

// handles calls to populate native GraphQL tables as well as what is needed for tooling
export async function handleCall(extrinsic: SubstrateExtrinsic): Promise<void> {
  await handleToolingCall(extrinsic);

  // TODO @prashantasdeveloper below code needs to be removed and moved to event handler

  // const { blockId, moduleId, callId, formattedParams } = getCallArgs(extrinsic);

  // const handlerArgs: [number, CallIdEnum, ModuleIdEnum, Record<string, any>, SubstrateExtrinsic] = [
  //   blockId,
  //   callId as CallIdEnum,
  //   moduleId as ModuleIdEnum,
  //   formattedParams,
  //   extrinsic,
  // ];

  // const handlerPromises = [mapAsset(...handlerArgs)];
  // await Promise.all(handlerPromises);
}

function getCallArgs(extrinsic: SubstrateExtrinsic) {
  const blockId = extrinsic.block.block.header.number.toString();
  const moduleId = extrinsic.extrinsic.method.section.toLowerCase();
  const callId = extrinsic.extrinsic.method.method;
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
  const params = serializeCallArgsLikeHarvester(extrinsic.extrinsic, logFoundType);
  const formattedParams = harvesterLikeParamsToObj(params);

  return {
    blockId,
    moduleId,
    callId,
    extrinsicIdx,
    signedbyAddress,
    address,
    params,
    formattedParams,
  };
}
