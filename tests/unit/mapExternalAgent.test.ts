import { mapExternalAgentAction } from '../../src/mappings/entities/externalAgents/mapExternalAgentAction';
import {
  handleExternalAgentAdded,
  handleExternalAgentRemoved,
} from '../../src/mappings/entities/externalAgents/mapExternalAgent';
import {
  handleAgentAdded,
  handleAgentRemoved,
  handleGroupChanged,
  handleGroupCreated,
} from '../../src/mappings/entities/externalAgents/mapExternalAgentHistory';
import { codec, mockStore, tupleEvent } from './helpers';

const ASSET_ID = '0xassetagent0000000000000000000000';
const DID_A = TEST_DID;

const getByFields = (): jest.Mock => (globalThis as any).store.getByFields as jest.Mock;

describe('AgentAdded — one event, three tables', () => {
  it('produces exactly one AssetAgent, one AssetAgentHistory, and one AssetAgentAction row', async () => {
    const db = mockStore();
    getByFields().mockResolvedValue([]);

    const event = tupleEvent({
      section: 'externalAgents',
      method: 'AgentAdded',
      data: [codec(DID_A), codec(ASSET_ID), codec({ full: null })],
    });

    // `AgentAdded` is registered against all three handlers in project.ts, driven from one event.
    await handleExternalAgentAdded(event);
    await handleAgentAdded(event);
    await mapExternalAgentAction(event);

    expect(Object.keys(db.AssetAgent ?? {})).toHaveLength(1);
    expect(Object.keys(db.AssetAgentHistory ?? {})).toHaveLength(1);
    expect(Object.keys(db.AssetAgentAction ?? {})).toHaveLength(1);

    const [agent] = Object.values(db.AssetAgent) as any[];
    const [history] = Object.values(db.AssetAgentHistory) as any[];

    expect(agent).toMatchObject({ assetId: ASSET_ID, identityId: DID_A });
    expect(history).toMatchObject({
      assetId: ASSET_ID,
      identityId: DID_A,
      type: 'AgentAdded',
    });
  });
});

describe('AgentGroup', () => {
  it('is queryable by assetId with no id string-parsing', async () => {
    const db = mockStore();

    await handleGroupCreated(
      tupleEvent({
        section: 'externalAgents',
        method: 'GroupCreated',
        data: [codec(DID_A), codec(ASSET_ID), codec(1), codec({ these: [] })],
      })
    );

    const [group] = Object.values(db.AgentGroup) as any[];

    expect(group.assetId).toBe(ASSET_ID);
  });
});

describe('membership lifecycle', () => {
  it('added → group changed → removed produces three AssetAgentHistory rows with the right types', async () => {
    const db = mockStore();
    getByFields().mockResolvedValue([]);

    await handleAgentAdded(
      tupleEvent({
        section: 'externalAgents',
        method: 'AgentAdded',
        data: [codec(DID_A), codec(ASSET_ID), codec({ full: null })],
        idx: 0,
      })
    );

    await handleGroupChanged(
      tupleEvent({
        section: 'externalAgents',
        method: 'GroupChanged',
        data: [codec(DID_A), codec(ASSET_ID), codec(DID_A), codec({ exceptMeta: null })],
        idx: 1,
      })
    );

    // project.ts registers both handlers on `AgentRemoved`: one drops the current-membership
    // row, the other appends the history row.
    await handleExternalAgentRemoved(
      tupleEvent({
        section: 'externalAgents',
        method: 'AgentRemoved',
        data: [codec(DID_A), codec(ASSET_ID), codec(DID_A)],
        idx: 2,
      })
    );
    await handleAgentRemoved(
      tupleEvent({
        section: 'externalAgents',
        method: 'AgentRemoved',
        data: [codec(DID_A), codec(ASSET_ID), codec(DID_A)],
        idx: 2,
      })
    );

    const types = Object.values(db.AssetAgentHistory)
      .map((row: any) => row.type)
      .sort();

    expect(types).toEqual(['AgentAdded', 'AgentRemoved', 'GroupChanged'].sort());
  });
});
