import { SubstrateEvent } from '@subql/types';
import { argumentNames, metadataTypeNames } from '../../../decode';
import { AnomalyKind, Event } from '../../../types';
import { argumentsJson, tryEncodeArgs } from '../../args/encode';
import { recordAnomaly } from '../../../utils/anomaly';
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
  const { args, refs, failure } = tryEncodeArgs(
    params,
    argumentNames(event),
    metadataTypeNames(event)
  );

  if (failure !== undefined) {
    await recordAnomaly({
      kind: AnomalyKind.UnreadableValue,
      detail: `${failure}, so the event's args and refs were left empty`,
      block,
      eventIdx,
      moduleId,
      eventId,
    });
  }

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
    args: argumentsJson(args),
    refs: await toEventRefs(refs, block.specVersion),
    extrinsicId,
  });
}
