import { GenericEvent } from '@polkadot/types/generic';
import { SubstrateBlock, SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import { ClaimTypeEnum, Event, EventIdEnum, ModuleIdEnum } from '../../types';
import {
  extractClaimInfo,
  extractCorporateActionTicker,
  extractEventArgs,
  extractOfferingAsset,
  extractTransferTo,
} from '../generatedColumns';
import { serializeLikeHarvester } from '../serializeLikeHarvester';
import { logError, logFoundType } from '../util';
import { HandlerArgs } from './common';
import { mapAsset } from './mapAsset';
import { mapAuthorization } from './mapAuthorization';
import { mapBridgeEvent } from './mapBridgeEvent';
import { mapClaim } from './mapClaim';
import { mapCompliance } from './mapCompliance';
import { mapCorporateActions } from './mapCorporateActions';
import { mapExternalAgentAction } from './mapExternalAgentAction';
import { mapIdentities } from './mapIdentities';
import { mapMultiSig } from './mapMultiSig';
import { mapNft } from './mapNfts';
import { mapPolyxTransaction } from './mapPolyxTransaction';
import { mapPortfolio } from './mapPortfolio';
import { mapProposal } from './mapProposal';
import { mapSettlement } from './mapSettlement';
import { mapStakingEvent } from './mapStakingEvent';
import { mapStatistics } from './mapStatistics';
import { mapSto } from './mapSto';
import { mapTickerExternalAgent } from './mapTickerExternalAgent';
import { mapTickerExternalAgentHistory } from './mapTickerExternalAgentHistory';
import { mapTransferManager } from './mapTransferManager';
import { mapTrustedClaimIssuer } from './mapTrustedClaimIssuer';
import { mapCustomClaimType } from './mapCustomClaimType';

export function handleToolingEvent(
  event: SubstrateEvent,
  eventIdx: number,
  block: SubstrateBlock,
  extrinsic?: SubstrateExtrinsic
): Event {
  const genericEvent = event.event as GenericEvent;
  const blockId = block.block.header.number.toString();
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

  let extrinsicId: string;
  if (extrinsic) {
    extrinsicId = `${blockId}/${extrinsic?.idx}`;
  }

  return Event.create({
    id: `${blockId}/${eventIdx}`,
    blockId,
    eventIdx,
    extrinsicIdx: extrinsic?.idx,
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
    extrinsicId,
  });
}

// handles an event to populate native GraphQL tables as well as what is needed for tooling
export async function createEvent(
  event: SubstrateEvent,
  eventIdx: number,
  block: SubstrateBlock,
  extrinsic?: SubstrateExtrinsic
): Promise<Event> {
  const genericEvent = event.event as GenericEvent;
  const moduleId = genericEvent.section.toLowerCase();
  const eventId = genericEvent.method;
  const dbEvent = handleToolingEvent(event, eventIdx, block, extrinsic);
  try {
    const blockId = block.block.header.number.toString();
    const args = genericEvent.data;

    const handlerArgs: HandlerArgs = {
      blockId,
      eventId: eventId as EventIdEnum,
      moduleId: moduleId as ModuleIdEnum,
      params: args,
      eventIdx,
      block,
      extrinsic,
    };

    const handlerPromises = [
      mapIdentities(handlerArgs),
      mapAsset(handlerArgs),
      mapNft(handlerArgs),
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
      mapMultiSig(handlerArgs),
      mapCustomClaimType(handlerArgs),
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
  return dbEvent;
}
