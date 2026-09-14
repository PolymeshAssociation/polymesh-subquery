import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { AssetAgent } from '../../../types';
import { getAssetId, getTextValue } from '../../../utils';
import { extractArgs } from '../common';

export const handleExternalAgentAdded = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { did, assetId: rawAssetId } = decodeEvent(event);

  const identityId = getTextValue(did);
  const assetId = await getAssetId(rawAssetId, block);

  // `group` / `permissions` are left unset here: `AgentAdded`'s third param (`AgentGroup`) sets
  // the initial group, but `GroupChanged` — the only handler that later moves an agent between
  // groups — has no counterpart writing to `AssetAgent`, so populating them only on add would go
  // stale the first time an agent's group changes. `AssetAgentHistory` is the reliable source for
  // an agent's group/permission timeline until both paths are wired together.
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
