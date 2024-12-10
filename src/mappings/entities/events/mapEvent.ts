import { GenericEvent } from '@polkadot/types/generic';
import { SubstrateEvent } from '@subql/types';
import { Event } from '../../../types';
import {
  extractClaimInfo,
  extractCorporateActionTicker,
  extractEventArgs,
  extractOfferingAsset,
  extractTransferTo,
  logFoundType,
} from '../../../utils';
import { serializeLikeHarvester } from '../../serializeLikeHarvester';
import { extractArgs } from '../common';

export function handleToolingEvent(event: SubstrateEvent): Event {
  const {
    block,
    blockEventId,
    eventIdx,
    extrinsicId,
    extrinsicIdx,
    blockId,
    eventId,
    moduleId,
    params: args,
  } = extractArgs(event);
  const genericEvent = event.event as GenericEvent;

  const harvesterLikeArgs = args.map((arg, i) => {
    let type: string;
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

  return Event.create({
    id: blockEventId,
    blockId,
    eventIdx,
    extrinsicIdx,
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
    extrinsicId,
  });
}
