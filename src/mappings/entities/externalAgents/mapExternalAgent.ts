import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { TickerExternalAgent } from '../../../types';
import { getAssetId, getTextValue } from '../../../utils';
import { extractArgs } from '../common';

export const handleExternalAgentAdded = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, eventIdx, block, blockEventId } = extractArgs(event);
  const { did, assetId: rawAssetId } = decodeEvent(event);

  const callerId = getTextValue(did);
  const assetId = await getAssetId(rawAssetId, block);

  await TickerExternalAgent.create({
    id: `${assetId}/${callerId}`,
    assetId,
    callerId,
    eventIdx,
    datetime: block.timestamp,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};

export const handleExternalAgentRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { block } = extractArgs(event);
  const { assetId: rawAssetId, agentDid } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);

  await TickerExternalAgent.remove(`${assetId}/${agentDid.toString()}`);
};
