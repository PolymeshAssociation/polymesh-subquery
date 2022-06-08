import { TickerExternalAgentAdded } from '../../types';
import { getTextValue, serializeTicker } from '../util';
import { EventIdEnum, HandlerArgs, ModuleIdEnum } from './common';

export async function mapTickerExternalAgentAdded({
  blockId,
  eventId,
  moduleId,
  params,
  event,
}: HandlerArgs): Promise<void> {
  if (moduleId === ModuleIdEnum.Externalagents && eventId === EventIdEnum.AgentAdded) {
    const callerId = getTextValue(params[0]);
    const ticker = serializeTicker(params[1]);

    await TickerExternalAgentAdded.create({
      id: `${ticker}/${callerId}`,
      ticker,
      callerId,
      eventIdx: event.idx,
      datetime: event.block.timestamp,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  }

  if (moduleId === ModuleIdEnum.Externalagents && eventId === EventIdEnum.AgentRemoved) {
    const agent = params[2].toString();
    const ticker = serializeTicker(params[1]);
    await TickerExternalAgentAdded.remove(`${ticker}/${agent}`);
  }
}
