import { SubstrateEvent } from '@subql/types';
import { argumentNames, metadataTypeNames } from '../../../decode';
import { ArgumentsJson, Event, EventReference } from '../../../types';
import { encodeArgs } from '../../args/encode';
import { toEventReferences } from '../../args/references';
import { extractArgs } from '../common';

export async function handleToolingEvent(
  event: SubstrateEvent
): Promise<{ event: Event; references: EventReference[] }> {
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

  return {
    event: Event.create({
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
      extrinsicId,
    }),
    references: await toEventReferences(refs, blockEventId, block.specVersion),
  };
}
