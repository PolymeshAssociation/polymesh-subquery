import { GenericEvent } from '@polkadot/types/generic';
import { SubstrateEvent } from '@subql/types';
import { Event, EventIdEnum, ModuleIdEnum } from '../../types';
import {
  extractClaimInfo,
  extractCorporateActionTicker,
  extractEventArgs,
  extractOfferingAsset,
  extractTransferTo,
} from '../generatedColumns';
import { serializeLikeHarvester } from '../serializeLikeHarvester';
import { logFoundType } from '../util';

export function handleToolingEvent(event: SubstrateEvent): Event {
  const block = event.block;
  const eventIdx = event.idx;
  const extrinsic = event.extrinsic;
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
