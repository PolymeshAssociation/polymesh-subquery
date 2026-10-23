/**
 * From 7.4, accepting an asset's ownership makes the new owner a Full agent (`AgentAdded`) and
 * removes the previous owner from the agents, with no event for the removal.
 */
import { handleOwnerReplacedAsAgent } from '../../src/mappings/entities/externalAgents/mapExternalAgentHistory';
import { codec, mockGetByFields, mockStore, tupleEvent } from './helpers';

const ASSET = `0x${'aa'.repeat(16)}`;
const OWNER = `0x${'01'.repeat(32)}`;
const BUYER = `0x${'02'.repeat(32)}`;

const transferred = (specVersion: number) =>
  tupleEvent({
    section: 'asset',
    method: 'AssetOwnershipTransferred',
    specVersion,
    blockNumber: '500',
    idx: 3,
    data: [codec(BUYER), codec(ASSET), codec(OWNER)],
  });

const withOwnerAgent = () => {
  const db = mockStore({
    AssetAgent: {
      [`${ASSET}/${OWNER}`]: { id: `${ASSET}/${OWNER}`, assetId: ASSET, identityId: OWNER },
    },
    AgentGroupMembership: { m: { id: 'm', memberId: OWNER, groupId: `${ASSET}/1` } },
  });
  mockGetByFields(db, 'AgentGroupMembership');
  (globalThis as any).store.bulkRemove = jest.fn(async (entity: string, ids: string[]) =>
    ids.forEach(id => delete db[entity][id])
  );
  return db;
};

it('removes the previous owner from the agents from 7.4, with its history', async () => {
  const db = withOwnerAgent();

  await handleOwnerReplacedAsAgent(transferred(7_004_000));

  expect(db.AssetAgent[`${ASSET}/${OWNER}`]).toBeUndefined();
  expect(db.AgentGroupMembership.m).toBeUndefined();
  expect(Object.values(db.AssetAgentHistory)).toEqual([
    expect.objectContaining({ assetId: ASSET, identityId: OWNER, type: 'AgentRemoved' }),
  ]);
});

it('leaves the previous owner an agent before 7.4, which kept it', async () => {
  const db = withOwnerAgent();

  await handleOwnerReplacedAsAgent(transferred(7_003_003));

  expect(db.AssetAgent[`${ASSET}/${OWNER}`]).toBeDefined();
});
