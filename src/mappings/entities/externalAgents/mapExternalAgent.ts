import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { AssetAgent } from '../../../types';
import { getAssetId, getTextValue } from '../../../utils';
import { extractArgs } from '../common';

export const handleExternalAgentAdded = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { agentDid: did, assetId: rawAssetId } = decodeEvent(event);

  const identityId = getTextValue(did);
  const assetId = await getAssetId(rawAssetId, block);

  // The row records membership only. An agent's permissions belong to the `AgentGroup` it is in,
  // so copying them here would be a second source going stale the first time `GroupChanged` moves
  // the agent — `AssetAgentHistory` carries the group and permission timeline instead.
  await AssetAgent.create({
    id: `${assetId}/${identityId}`,
    assetId,
    identityId,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();
};

export const handleExternalAgentRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { block } = extractArgs(event);
  const { assetId: rawAssetId, agentDid } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);

  await AssetAgent.remove(`${assetId}/${agentDid.toString()}`);
};
