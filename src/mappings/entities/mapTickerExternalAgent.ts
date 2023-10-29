import { EventIdEnum, ModuleIdEnum, TickerExternalAgent } from '../../types';
import { getTextValue, serializeTicker } from '../util';
import { HandlerArgs } from './common';

export async function mapTickerExternalAgent({
  blockId,
  eventId,
  moduleId,
  params,
  eventIdx,
  block,
}: HandlerArgs): Promise<void> {
  if (moduleId === ModuleIdEnum.externalagents && eventId === EventIdEnum.AgentAdded) {
    const callerId = getTextValue(params[0]);
    const ticker = serializeTicker(params[1]);

    await TickerExternalAgent.create({
      id: `${ticker}/${callerId}`,
      assetId: ticker,
      callerId,
      eventIdx,
      datetime: block.timestamp,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  }

  if (moduleId === ModuleIdEnum.externalagents && eventId === EventIdEnum.AgentRemoved) {
    const agent = params[2].toString();
    const ticker = serializeTicker(params[1]);
    await TickerExternalAgent.remove(`${ticker}/${agent}`);
  }
}
