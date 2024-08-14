import { SubstrateEvent } from '@subql/types';
import { TickerExternalAgent } from '../../types';
import { getAssetId, getTextValue } from '../../utils';
import { extractArgs } from './common';

export const handleExternalAgentAdded = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, eventIdx, block } = extractArgs(event);
  const callerId = getTextValue(params[0]);
  const assetId = getAssetId(params[1], block);

  await TickerExternalAgent.create({
    id: `${assetId}/${callerId}`,
    assetId,
    callerId,
    eventIdx,
    datetime: block.timestamp,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const handleExternalAgentRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { params, block } = extractArgs(event);
  const agent = params[2].toString();
  const assetId = getAssetId(params[1], block);
  await TickerExternalAgent.remove(`${assetId}/${agent}`);
};
