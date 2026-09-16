import { ArityMismatch, decodeEvent } from '../../src/decode';
import {
  handleCheckpointCreated,
  handleScheduleCreated,
  handleScheduleRemoved,
  parseSchedule,
} from '../../src/mappings/entities/assets/mapCheckpoint';
import { getAssetId } from '../../src/utils';
import { codec, mockStore, tupleEvent } from './helpers';

const PRE_V6_SPEC = 5_004_003;
const V6_SPEC = 6_000_001;
// Already `0x`-prefixed so `getAssetId`'s legacy-ticker path (pre-v7) and the direct passthrough
// (v7+) agree on the same value — a bare identifier would only survive the passthrough branch,
// since the legacy path hex-encodes a plain *string* but takes a Codec's `.toString()` verbatim.
const RAW_ASSET_ID = '0xabc123def456';

const assetIdAt = (specVersion: number) => getAssetId(RAW_ASSET_ID, { specVersion } as never);

describe('handleCheckpointCreated', () => {
  it('creates a Checkpoint from the totalSupply and moment params', async () => {
    const db = mockStore();
    const assetId = await assetIdAt(8_000_000);

    await handleCheckpointCreated(
      tupleEvent({
        section: 'checkpoint',
        method: 'CheckpointCreated',
        data: [
          codec(TEST_DID),
          codec(RAW_ASSET_ID),
          codec(5),
          codec(1_000_000),
          codec(1_700_000_000_000),
        ],
      })
    );

    expect(db.Checkpoint[`${assetId}/5`]).toMatchObject({
      assetId,
      checkpointId: 5,
      totalSupply: BigInt(1_000_000),
      datetime: new Date(1_700_000_000_000),
    });
  });
});

describe('parseSchedule', () => {
  const preV6Event = tupleEvent({
    section: 'checkpoint',
    method: 'ScheduleCreated',
    data: [
      codec(TEST_DID),
      codec(RAW_ASSET_ID),
      codec({
        schedule: { start: 1_000, period: { unit: 'Month', amount: 1 } },
        id: 7,
        at: 2_000,
        remaining: 4,
      }),
    ],
    specVersion: PRE_V6_SPEC,
  });

  const v6Event = tupleEvent({
    section: 'checkpoint',
    method: 'ScheduleCreated',
    data: [codec(TEST_DID), codec(RAW_ASSET_ID), codec(9), codec({ pending: [3_000, 4_000] })],
    specVersion: V6_SPEC,
  });

  it('recovers the scheduleId from the nested StoredSchedule.id pre-v6 and leaves pendingCheckpoints null', () => {
    const parsed = parseSchedule(decodeEvent(preV6Event), PRE_V6_SPEC);

    expect(parsed.scheduleId).toBe(7);
    expect(parsed.remaining).toBe(4);
    expect(parsed.nextCheckpointAt).toEqual(new Date(2_000));
    expect(parsed.pendingCheckpoints).toBeUndefined();
  });

  it('reads scheduleId from params[2] at v6+ and leaves the period fields null', () => {
    const parsed = parseSchedule(decodeEvent(v6Event), V6_SPEC);

    expect(parsed.scheduleId).toBe(9);
    expect(parsed.pendingCheckpoints).toEqual([new Date(3_000), new Date(4_000)]);
    expect(parsed.period).toBeUndefined();
    expect(parsed.start).toBeUndefined();
  });

  it('throws ArityMismatch when a v6+ block reports the pre-v6 3-param arity', () => {
    const threeParamAtV6 = tupleEvent({
      section: 'checkpoint',
      method: 'ScheduleCreated',
      data: [
        codec(TEST_DID),
        codec(RAW_ASSET_ID),
        codec({ schedule: {}, id: 1, at: 1, remaining: 1 }),
      ],
      specVersion: V6_SPEC,
    });

    expect(() => decodeEvent(threeParamAtV6)).toThrow(ArityMismatch);
  });

  it('throws ArityMismatch when a pre-v6 block reports the v6+ 4-param arity', () => {
    const fourParamPreV6 = tupleEvent({
      section: 'checkpoint',
      method: 'ScheduleCreated',
      data: [codec(TEST_DID), codec(RAW_ASSET_ID), codec(1), codec({ pending: [] })],
      specVersion: PRE_V6_SPEC,
    });

    expect(() => decodeEvent(fourParamPreV6)).toThrow(ArityMismatch);
  });
});

describe('handleScheduleCreated / handleScheduleRemoved', () => {
  it('creates a pre-v6 schedule with period/remaining populated and pendingCheckpoints null', async () => {
    const db = mockStore();
    const assetId = await assetIdAt(PRE_V6_SPEC);

    await handleScheduleCreated(
      tupleEvent({
        section: 'checkpoint',
        method: 'ScheduleCreated',
        data: [
          codec(TEST_DID),
          codec(RAW_ASSET_ID),
          codec({
            schedule: { start: 1_000, period: { unit: 'Month', amount: 1 } },
            id: 7,
            at: 2_000,
            remaining: 4,
          }),
        ],
        specVersion: PRE_V6_SPEC,
      })
    );

    const schedule = db.CheckpointSchedule[`${assetId}/7`];

    expect(schedule).toMatchObject({ assetId, scheduleId: 7, remaining: 4 });
    expect(schedule.pendingCheckpoints).toBeUndefined();
  });

  it('creates a v6+ schedule with pendingCheckpoints populated and period null, then removes it', async () => {
    const db = mockStore();
    const assetId = await assetIdAt(V6_SPEC);

    await handleScheduleCreated(
      tupleEvent({
        section: 'checkpoint',
        method: 'ScheduleCreated',
        data: [codec(TEST_DID), codec(RAW_ASSET_ID), codec(9), codec({ pending: [3_000] })],
        specVersion: V6_SPEC,
      })
    );

    const schedule = db.CheckpointSchedule[`${assetId}/9`];

    expect(schedule.pendingCheckpoints).toEqual([new Date(3_000)]);
    expect(schedule.period).toBeUndefined();
    expect(schedule.removedEventId).toBeUndefined();

    await handleScheduleRemoved(
      tupleEvent({
        section: 'checkpoint',
        method: 'ScheduleRemoved',
        data: [codec(TEST_DID), codec(RAW_ASSET_ID), codec(9), codec({ pending: [3_000] })],
        specVersion: V6_SPEC,
        idx: 1,
      })
    );

    expect(db.CheckpointSchedule[`${assetId}/9`].removedEventId).toBeDefined();
  });
});
