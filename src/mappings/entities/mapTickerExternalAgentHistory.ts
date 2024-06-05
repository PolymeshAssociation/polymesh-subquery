import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import {
  AgentGroup as AgentGroupEntity,
  AgentGroupMembership,
  TickerExternalAgentHistory,
} from '../../types';
import { serializeTicker } from '../util';
import { extractArgs } from './common';

export const handleGroupCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const group = params[2].toJSON();
  const permissions = JSON.stringify(params[3].toJSON());
  const ticker = serializeTicker(params[1]);

  await AgentGroupEntity.create({
    id: `${ticker}/${group}`,
    permissions,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const handleGroupPermissionsUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, eventIdx, block } = extractArgs(event);

  const group = params[2].toJSON();
  const permissions = JSON.stringify(params[3].toJSON());
  const ticker = serializeTicker(params[1]);

  const ag = await AgentGroupEntity.get(`${ticker}/${group}`);
  ag.permissions = permissions;

  const promises = [ag.save()];
  const members = await AgentGroupMembership.getByGroupId(`${ticker}/${group}`);

  for (const member of members) {
    promises.push(
      TickerExternalAgentHistory.create({
        id: `${blockId}/${eventIdx}/${member.member}`,
        assetId: ticker,
        identityId: member.member,
        eventIdx,
        datetime: block.timestamp,
        type: 'AgentPermissionsChanged',
        permissions,
        createdBlockId: blockId,
        updatedBlockId: blockId,
      }).save()
    );
  }
  await Promise.all(promises);
};

export const handleAgentAdded = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, eventIdx, block } = extractArgs(event);

  const did = params[0].toString();
  const ticker = serializeTicker(params[1]);
  const group = params[2].toJSON() as AgentGroup;

  const promises = [
    addTickerExternalAgentHistory(ticker, group, blockId, eventIdx, did, block, 'AgentAdded'),
  ];

  // Only keep track of membership for custom agent groups.
  if (isCustom(group)) {
    promises.push(addAgentGroupMembership(blockId, ticker, group, did));
  }
  await Promise.all(promises);
};

export const handleGroupChanged = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, eventIdx, block } = extractArgs(event);

  const did = params[2].toString();
  const group = params[3].toJSON() as AgentGroup;
  const ticker = serializeTicker(params[1]);

  const promises = [
    removeMember(did, ticker),
    addTickerExternalAgentHistory(
      ticker,
      group,
      blockId,
      eventIdx,
      did,
      block,
      'AgentPermissionsChanged'
    ),
  ];

  // Only keep track of membership for custom agent groups.
  if (isCustom(group)) {
    promises.push(addAgentGroupMembership(blockId, ticker, group, did));
  }
  await Promise.all(promises);
};

export async function handleAgentRemoved(event: SubstrateEvent): Promise<void> {
  const { params, blockId, eventIdx, block } = extractArgs(event);
  const did = params[2].toString();
  const ticker = serializeTicker(params[1]);

  const promises = [
    removeMember(did, ticker),
    TickerExternalAgentHistory.create({
      id: `${blockId}/${eventIdx}/${did}`,
      assetId: ticker,
      identityId: did,
      eventIdx,
      datetime: block.timestamp,
      type: 'AgentRemoved',
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save(),
  ];

  await Promise.all(promises);
}

const addTickerExternalAgentHistory = async (
  ticker: string,
  group: AgentGroup,
  blockId: string,
  eventIdx: number,
  did: string,
  block: SubstrateBlock,
  type: 'AgentAdded' | 'AgentPermissionsChanged'
): Promise<void> => {
  const permissions = await permissionsFromAgentGroup(ticker, group, async n => {
    const ag = await AgentGroupEntity.get(`${ticker}/${n}`);
    return ag.permissions;
  });
  await TickerExternalAgentHistory.create({
    id: `${blockId}/${eventIdx}/${did}`,
    assetId: ticker,
    identityId: did,
    eventIdx,
    datetime: block.timestamp,
    type,
    permissions,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

const addAgentGroupMembership = (
  blockId: string,
  ticker: string,
  group: CustomAG,
  did: string
): Promise<void> => {
  return AgentGroupMembership.create({
    id: `${ticker}/${group.custom}/${did}`,
    member: did,
    groupId: `${ticker}/${group.custom}`,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

const removeMember = async (did: string, ticker: string) => {
  const memberships = await AgentGroupMembership.getByMember(did);
  for (const membership of memberships) {
    const t = membership.groupId.split('/')[0];
    if (ticker === t) {
      await AgentGroupMembership.remove(`${membership.groupId}/${did}`);
      return;
    }
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
 * @returns The permissions that correspond to `ag` in `ticker`
 * @param ticker
 * @param ag
 * @param customPermissions function to get the permissions for a given custom group number
 */
const permissionsFromAgentGroup = async (
  ticker: string,
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
        `No permissions found for custom agent group ${ag.custom} in ticker ${ticker}`
      );
    }
    return p;
  }
  throw new Error(`unknown agent group type: ${JSON.stringify(ag)} in ticker ${ticker}`);
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
