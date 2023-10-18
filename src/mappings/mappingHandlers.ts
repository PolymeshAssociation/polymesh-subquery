import { Vec } from '@polkadot/types/codec';
import { GenericExtrinsic } from '@polkadot/types/extrinsic';
import { GenericEvent } from '@polkadot/types/generic';
import { AnyTuple } from '@polkadot/types/types';
import { hexStripPrefix } from '@polkadot/util';
import { SubstrateBlock, SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import {
  Block,
  CallIdEnum,
  ClaimTypeEnum,
  Event,
  EventIdEnum,
  Extrinsic,
  ModuleIdEnum,
} from '../types';
import { HandlerArgs } from './entities/common';
import { mapAsset } from './entities/mapAsset';
import { mapAuthorization } from './entities/mapAuthorization';
import { mapBridgeEvent } from './entities/mapBridgeEvent';
import { mapClaim } from './entities/mapClaim';
import { mapCompliance } from './entities/mapCompliance';
import { mapCorporateActions } from './entities/mapCorporateActions';
import { mapExternalAgentAction } from './entities/mapExternalAgentAction';
import { mapIdentities } from './entities/mapIdentities';
import { mapPolyxTransaction } from './entities/mapPolyxTransaction';
import { mapPortfolio } from './entities/mapPortfolio';
import { mapProposal } from './entities/mapProposal';
import { mapSettlement } from './entities/mapSettlement';
import { mapStakingEvent } from './entities/mapStakingEvent';
import { mapStatistics } from './entities/mapStatistics';
import { mapSto } from './entities/mapSto';
import mapSubqueryVersion from './entities/mapSubqueryVersion';
import { mapTickerExternalAgent } from './entities/mapTickerExternalAgent';
import { mapTickerExternalAgentHistory } from './entities/mapTickerExternalAgentHistory';
import { mapTransferManager } from './entities/mapTransferManager';
import { mapTrustedClaimIssuer } from './entities/mapTrustedClaimIssuer';
import {
  extractClaimInfo,
  extractCorporateActionTicker,
  extractEventArgs,
  extractOfferingAsset,
  extractTransferTo,
} from './generatedColumns';
import migrationHandlers from './migrations/migrationHandlers';
import { serializeCallArgsLikeHarvester, serializeLikeHarvester } from './serializeLikeHarvester';
import { camelToSnakeCase, getSigner, logError, logFoundType } from './util';

export async function handleBlock(block: SubstrateBlock): Promise<void> {
  try {
    const header = block.block.header;
    const blockId = header.number.toNumber();
    const ss58Format = header.registry.chainSS58;

    let countExtrinsicsSuccess = 0;

    await mapSubqueryVersion().catch(e => logError(e));

    await migrationHandlers(blockId, ss58Format).catch(e => logError(e));

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
  } catch (error) {
    logError(`Received an error in handleBlock: ${error.toString()}`);
    throw error;
  }
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
  const genericEvent = event.event as GenericEvent;
  const block = event.block;
  const blockId = block.block.header.number.toString();
  const eventIdx = event.idx;
  const moduleId = genericEvent.section.toLowerCase();
  const eventId = genericEvent.method;
  const args = genericEvent.data;

  const harvesterLikeArgs = args.map((arg, i) => {
    let type;
    const typeName = genericEvent.meta.fields[i].typeName;
    if (typeName.isSome) {
      // for metadata >= v14
      type = typeName.unwrap().toString();
    } else {
      // for metadata < v14
      type = genericEvent.meta.args[i].toString();
    }
    return {
      value: serializeLikeHarvester(arg, type, logFoundType),
    };
  });

  const { eventArg_0, eventArg_1, eventArg_2, eventArg_3 } = extractEventArgs(harvesterLikeArgs);

  const { claimExpiry, claimIssuer, claimScope, claimType } = extractClaimInfo(harvesterLikeArgs);

  await Event.create({
    id: `${blockId}/${eventIdx}`,
    blockId,
    eventIdx,
    extrinsicIdx: event?.extrinsic?.idx,
    specVersionId: block.specVersion,
    eventId: eventId as EventIdEnum,
    moduleId: moduleId as ModuleIdEnum,
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

// handles an event to populate native GraphQL tables as well as what is needed for tooling
export async function handleEvent(event: SubstrateEvent): Promise<void> {
  const genericEvent = event.event as GenericEvent;
  const moduleId = genericEvent.section.toLowerCase();
  const eventId = genericEvent.method;
  try {
    await handleToolingEvent(event);

    const block = event.block;
    const blockId = block.block.header.number.toString();
    const args = genericEvent.data;

    const handlerArgs: HandlerArgs = {
      blockId,
      eventId: eventId as EventIdEnum,
      moduleId: moduleId as ModuleIdEnum,
      params: args,
      event,
    };

    const handlerPromises = [
      mapIdentities(handlerArgs),
      mapAsset(handlerArgs),
      mapCompliance(handlerArgs),
      mapTransferManager(handlerArgs),
      mapStatistics(handlerArgs),
      mapPortfolio(handlerArgs),
      mapSettlement(handlerArgs),
      mapStakingEvent(handlerArgs),
      mapBridgeEvent(handlerArgs),
      mapSto(handlerArgs),
      mapExternalAgentAction(handlerArgs),
      mapTickerExternalAgent(handlerArgs),
      mapTickerExternalAgentHistory(handlerArgs),
      mapAuthorization(handlerArgs),
      mapCorporateActions(handlerArgs),
      mapProposal(handlerArgs),
      mapTrustedClaimIssuer(handlerArgs),
      mapPolyxTransaction(handlerArgs),
    ];

    const harvesterLikeArgs = args.map((arg, i) => ({
      value: serializeLikeHarvester(arg, genericEvent.meta.args[i].toString(), logFoundType),
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
      customClaimTypeId,
    } = extractClaimInfo(harvesterLikeArgs);

    handlerPromises.push(
      mapClaim(handlerArgs, {
        claimExpiry,
        claimIssuer,
        claimScope,
        claimType: claimType as ClaimTypeEnum,
        issuanceDate,
        lastUpdateDate,
        cddId,
        jurisdiction,
        customClaimTypeId,
      })
    );

    await Promise.all(handlerPromises);
  } catch (error) {
    logError(
      `Received an error in handleEvent while handling the event '${moduleId}.${eventId}': ${error.stack}`
    );
    throw error;
  }
}

export async function handleCall(extrinsic: SubstrateExtrinsic): Promise<void> {
  try {
    const blockId = extrinsic.block.block.header.number.toString();
    const extrinsicIdx = extrinsic.idx;
    const signedbyAddress = !extrinsic.extrinsic.signer.isEmpty;
    const address = signedbyAddress ? getSigner(extrinsic) : null;
    const params = serializeCallArgsLikeHarvester(extrinsic.extrinsic, logFoundType);

    await Extrinsic.create({
      id: `${blockId}/${extrinsicIdx}`,
      blockId,
      extrinsicIdx,
      extrinsicLength: extrinsic.extrinsic.length,
      signed: extrinsic.extrinsic.isSigned ? 1 : 0,
      moduleId: extrinsic.extrinsic.method.section.toLowerCase() as ModuleIdEnum,
      callId: camelToSnakeCase(extrinsic.extrinsic.method.method) as CallIdEnum,
      paramsTxt: JSON.stringify(params),
      success: extrinsic.success ? 1 : 0,
      signedbyAddress: signedbyAddress ? 1 : 0,
      address,
      nonce: extrinsic.extrinsic.nonce.toNumber(),
      extrinsicHash: hexStripPrefix(extrinsic.extrinsic.hash.toJSON()),
      specVersionId: extrinsic.block.specVersion,
    }).save();
  } catch (error) {
    logError(`Received an Error in handleCall function: ${error.toString()}`);
    throw error;
  }
}
