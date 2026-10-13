import { SubstrateEvent } from '@subql/types';
import { argumentNames, metadataTypeNames } from '../../../decode';
import { ArgumentsJson, Event } from '../../../types';
import { encodeArgs } from '../../args/encode';
import { toEventRefs } from '../../args/refs';
import { extractArgs } from '../common';

export async function handleToolingEvent(event: SubstrateEvent): Promise<Event> {
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
    params,
  } = extractArgs(event);
  const { args, refs } = encodeArgs(params, argumentNames(event), metadataTypeNames(event));

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
    args: args as unknown as ArgumentsJson,
    refs: await toEventRefs(refs, block.specVersion),
    extrinsicId,
  });
}
