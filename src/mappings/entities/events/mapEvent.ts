import { SubstrateEvent } from '@subql/types';
import { metadataTypeNames } from '../../../decode';
import { Event } from '../../../types';
import { extractEventArgs, logFoundType } from '../../../utils';
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
    eventIdText,
    moduleId,
    moduleIdText,
    params: args,
  } = extractArgs(event);
  const types = metadataTypeNames(event);

  const harvesterLikeArgs = args.map((arg, i) => ({
    value: serializeLikeHarvester(arg, types[i], logFoundType),
  }));

  const { eventArg_0, eventArg_1, eventArg_2, eventArg_3 } = extractEventArgs(harvesterLikeArgs);

  return Event.create({
    id: blockEventId,
    blockId,
    eventIdx,
    extrinsicIdx,
    specVersionId: block.specVersion,
    eventId,
    moduleId,
    moduleIdText,
    eventIdText,
    attributesTxt: JSON.stringify(harvesterLikeArgs),
    eventArg_0,
    eventArg_1,
    eventArg_2,
    eventArg_3,
    extrinsicId,
  });
}
