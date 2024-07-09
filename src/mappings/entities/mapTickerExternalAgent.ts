import { SubstrateEvent } from '@subql/types';
import { TickerExternalAgent } from '../../types';
import { getTextValue, serializeTicker } from '../../utils';
import { extractArgs } from './common';

export const handleExternalAgentAdded = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, eventIdx, block } = extractArgs(event);
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
};

export const handleExternalAgentRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { params } = extractArgs(event);
  const agent = params[2].toString();
  const ticker = serializeTicker(params[1]);
  await TickerExternalAgent.remove(`${ticker}/${agent}`);
};
