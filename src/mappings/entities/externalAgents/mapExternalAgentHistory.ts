import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import {
  AgentGroup as AgentGroupEntity,
  AgentGroupMembership,
  AgentHistoryType,
  AssetAgent,
  AssetAgentHistory,
} from '../../../types';
import { decodeEvent } from '../../../decode';
import { getAllByFields, getAssetId } from '../../../utils';
import { extractArgs } from '../common';
import { writeAssetAgent } from './mapExternalAgent';

export const handleGroupCreated = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { assetId: rawAssetId, agId, permissions: rawPermissions } = decodeEvent(event);

  const group = agId.toJSON();
  const permissions = JSON.stringify(rawPermissions.toJSON());
  const assetId = await getAssetId(rawAssetId, block);

  await AgentGroupEntity.create({
    id: `${assetId}/${group}`,
    assetId,
    permissions,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();
};

export const handleGroupPermissionsUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { assetId: rawAssetId, agId, permissions: rawPermissions } = decodeEvent(event);

  const group = agId.toJSON();
  const permissions = JSON.stringify(rawPermissions.toJSON());
  const assetId = await getAssetId(rawAssetId, block);

  const ag = await AgentGroupEntity.get(`${assetId}/${group}`);
  ag.permissions = permissions;

  const promises = [ag.save()];
  const members = await getAllByFields<AgentGroupMembership>('AgentGroupMembership', [
    ['groupId', '=', `${assetId}/${group}`],
  ]);

  for (const member of members) {
    promises.push(
      AssetAgentHistory.create({
        id: `${blockEventId}/${member.memberId}`,
        assetId,
        identityId: member.memberId,
        type: AgentHistoryType.AgentPermissionsChanged,
        permissions,
        createdEventId: blockEventId,
      }).save()
    );
  }
  await Promise.all(promises);
};

export const handleAgentAdded = async (event: SubstrateEvent): Promise<void> => {
  const { block } = extractArgs(event);
  const { agentDid: rawDid, assetId: rawAssetId, group: agentGroup } = decodeEvent(event);

  await recordAgentAdded(
    await getAssetId(rawAssetId, block),
    rawDid.toString(),
    agentGroup.toJSON() as AgentGroup,
    event
  );
};

/** The first runtime whose asset creation emits `AgentAdded` for the creator */
const CREATOR_AGENT_EVENT_FROM = 3_002;

/**
 * Before 3.2 creating an asset made its creator a Full agent with no `AgentAdded` (testnet's 3.0
 * and 3.1; mainnet went from 3.1 to 3.3), so the agent is recorded from the `AssetCreated`.
 */
export const handleCreatorAgent = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  if (block.specVersion >= CREATOR_AGENT_EVENT_FROM) {
    return;
  }
  const { callerDid, assetId: rawAssetId } = decodeEvent(event);
  const did = callerDid.toString();
  const assetId = await getAssetId(rawAssetId, block);

  await Promise.all([
    writeAssetAgent(assetId, did, blockEventId),
    recordAgentAdded(assetId, did, { full: null }, event),
  ]);
};

const recordAgentAdded = async (
  assetId: string,
  did: string,
  group: AgentGroup,
  event: SubstrateEvent
): Promise<void> => {
  const { blockId, eventIdx, block, blockEventId } = extractArgs(event);
  const promises = [
    addExternalAgentHistory(
      assetId,
      group,
      blockId,
      eventIdx,
      did,
      block,
      AgentHistoryType.AgentAdded,
      blockEventId
    ),
  ];

  // Only keep track of membership for custom agent groups.
  if (isCustom(group)) {
    promises.push(addAgentGroupMembership(blockEventId, assetId, group, did));
  }
  await Promise.all(promises);
};

export const handleGroupChanged = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, eventIdx, block, blockEventId } = extractArgs(event);
  const { assetId: rawAssetId, agentDid, group: agentGroup } = decodeEvent(event);

  const did = agentDid.toString();
  const group = agentGroup.toJSON() as AgentGroup;
  const assetId = await getAssetId(rawAssetId, block);

  const promises = [
    removeMember(did, assetId),
    addExternalAgentHistory(
      assetId,
      group,
      blockId,
      eventIdx,
      did,
      block,
      AgentHistoryType.GroupChanged,
      blockEventId
    ),
  ];

  // Only keep track of membership for custom agent groups.
  if (isCustom(group)) {
    promises.push(addAgentGroupMembership(blockEventId, assetId, group, did));
  }
  await Promise.all(promises);
};

export async function handleAgentRemoved(event: SubstrateEvent): Promise<void> {
  const { block, blockEventId } = extractArgs(event);
  const { assetId: rawAssetId, agentDid } = decodeEvent(event);

  const did = agentDid.toString();
  const assetId = await getAssetId(rawAssetId, block);

  const promises = [
    removeMember(did, assetId),
    AssetAgentHistory.create({
      id: `${blockEventId}/${did}`,
      assetId,
      identityId: did,
      type: AgentHistoryType.AgentRemoved,
      createdEventId: blockEventId,
    }).save(),
  ];

  await Promise.all(promises);
}

const addExternalAgentHistory = async (
  assetId: string,
  group: AgentGroup,
  blockId: string,
  eventIdx: number,
  did: string,
  block: SubstrateBlock,
  type: AgentHistoryType.AgentAdded | AgentHistoryType.GroupChanged,
  blockEventId: string
): Promise<void> => {
  const permissions = await permissionsFromAgentGroup(assetId, group, async n => {
    const ag = await AgentGroupEntity.get(`${assetId}/${n}`);
    return ag.permissions;
  });
  await AssetAgentHistory.create({
    id: `${blockEventId}/${did}`,
    assetId,
    identityId: did,
    type,
    permissions,
    createdEventId: blockEventId,
  }).save();
};

const addAgentGroupMembership = (
  blockEventId: string,
  assetId: string,
  group: CustomAG,
  did: string
): Promise<void> => {
  return AgentGroupMembership.create({
    id: `${assetId}/${group.custom}/${did}`,
    memberId: did,
    groupId: `${assetId}/${group.custom}`,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();
};

const removeMember = async (did: string, assetId: string) => {
  const memberships = await getAllByFields<AgentGroupMembership>('AgentGroupMembership', [
    ['memberId', '=', did],
  ]);

  const memberIds = memberships
    .filter(({ groupId }) => groupId.split('/')[0] === assetId)
    .map(({ id }) => id);

  if (memberIds.length > 0) {
    await store.bulkRemove('AgentGroupMembership', memberIds);
  }
};

type AgentGroup = FullAG | CustomAG | ExceptMetaAG | PolymeshV1CAAAG | PolymeshV1PIAAG;
type FullAG = { full: null };
type CustomAG = { custom: number };
type ExceptMetaAG = { exceptMeta: null };
type PolymeshV1CAAAG = { polymeshV1CAA: null };
type PolymeshV1PIAAG = { polymeshV1PIA: null };

const isFull = (ag: AgentGroup): ag is FullAG => (ag as FullAG).full === null;
const isCustom = (ag: AgentGroup): ag is CustomAG => (ag as CustomAG).custom !== undefined;
const isExceptMeta = (ag: AgentGroup): ag is ExceptMetaAG =>
  (ag as ExceptMetaAG).exceptMeta === null;
const isCAA = (ag: AgentGroup): ag is PolymeshV1CAAAG =>
  (ag as PolymeshV1CAAAG).polymeshV1CAA === null;
const isPIA = (ag: AgentGroup): ag is PolymeshV1PIAAG =>
  (ag as PolymeshV1PIAAG).polymeshV1PIA === null;

const wholePallets = (...pallets: string[]): ExtrinsicPermissions => ({
  these: pallets.map(pallet_name => ({
    pallet_name,
    dispatchable_names: { whole: null },
  })),
});

/**
 * @returns The permissions that correspond to `ag` in `assetId`
 * @param assetId
 * @param ag
 * @param customPermissions function to get the permissions for a given custom group number
 */
const permissionsFromAgentGroup = async (
  assetId: string,
  ag: AgentGroup,
  customPermissions: GetCustomGroupPermissions
): Promise<string> => {
  if (isFull(ag)) {
    const p: ExtrinsicPermissions = { whole: null };
    return JSON.stringify(p);
  } else if (isExceptMeta(ag)) {
    const p: ExtrinsicPermissions = {
      except: [{ pallet_name: 'ExternalAgents', dispatchable_names: { whole: null } }],
    };
    return JSON.stringify(p);
  } else if (isCAA(ag)) {
    return JSON.stringify(
      wholePallets('CorporateAction', 'CorporateBallot', 'CapitalDistribution')
    );
  } else if (isPIA(ag)) {
    const p: ExtrinsicPermissions = {
      these: [
        { pallet_name: 'Sto', dispatchable_names: { except: ['invest'] } },
        {
          pallet_name: 'Asset',
          dispatchable_names: {
            these: ['issue', 'redeem', 'controller_transfer'],
          },
        },
      ],
    };
    return JSON.stringify(p);
  } else if (isCustom(ag)) {
    const p = await customPermissions(ag.custom);
    if (p === undefined) {
      throw new Error(
        `No permissions found for custom agent group ${ag.custom} in asset ID ${assetId}`
      );
    }
    return p;
  }
  throw new Error(`unknown agent group type: ${JSON.stringify(ag)} in asset ID ${assetId}`);
};

type GetCustomGroupPermissions = (gn: number) => Promise<string>;

type PalletPermissions = {
  pallet_name: string;
  dispatchable_names: DispatchableNames;
};
type Whole = { whole: null };
type These<T> = { these: T[] };
type Except<T> = { except: T[] };
type DispatchableNames = Whole | These<string> | Except<string>;
type ExtrinsicPermissions = Whole | These<PalletPermissions> | Except<PalletPermissions>;

/** The first runtime whose ownership transfer takes the previous owner out of the agents */
const OWNER_LEAVES_AGENTS_FROM = 7_004_000;

/**
 * From 7.4, accepting an asset's ownership removes the previous owner from its agents, which the
 * chain does with no event (the new owner's `AgentAdded` comes with it).
 */
export async function handleOwnerReplacedAsAgent(event: SubstrateEvent): Promise<void> {
  const { block, blockEventId } = extractArgs(event);
  if (block.specVersion < OWNER_LEAVES_AGENTS_FROM) {
    return;
  }
  const { assetId: rawAssetId, oldOwnerDid } = decodeEvent(event);
  const did = oldOwnerDid.toString();
  const assetId = await getAssetId(rawAssetId, block);
  const agentId = `${assetId}/${did}`;
  if (!(await AssetAgent.get(agentId))) {
    return;
  }

  await Promise.all([
    AssetAgent.remove(agentId),
    removeMember(did, assetId),
    AssetAgentHistory.create({
      id: `${blockEventId}/${did}`,
      assetId,
      identityId: did,
      type: AgentHistoryType.AgentRemoved,
      createdEventId: blockEventId,
    }).save(),
  ]);
}
