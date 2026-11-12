import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { AssetAgent } from '../../../types';
import { getAssetId, getTextValue } from '../../../utils';
import { extractArgs } from '../common';

export const writeAssetAgent = (
  assetId: string,
  identityId: string,
  blockEventId: string
): Promise<void> =>
  // The row records membership only. An agent's permissions belong to the `AgentGroup` it is in,
  // so copying them here would be a second source going stale the first time `GroupChanged` moves
  // the agent — `AssetAgentHistory` carries the group and permission timeline instead.
  AssetAgent.create({
    id: `${assetId}/${identityId}`,
    assetId,
    identityId,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();

export const handleExternalAgentAdded = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { agentDid: did, assetId: rawAssetId } = decodeEvent(event);

  await writeAssetAgent(await getAssetId(rawAssetId, block), getTextValue(did), blockEventId);
};

export const handleExternalAgentRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { block } = extractArgs(event);
  const { assetId: rawAssetId, agentDid } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);

  await AssetAgent.remove(`${assetId}/${agentDid.toString()}`);
};
