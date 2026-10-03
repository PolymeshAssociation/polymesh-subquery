import { ArityMismatch, decodeEvent } from '../../src/decode';
import {
  handleCheckpointCreated,
  handleScheduleCreated,
  handleScheduleRemoved,
  parseSchedule,
} from '../../src/mappings/entities/assets/mapCheckpoint';
import { IndexerAnomaly } from '../../src/types';
import { getAssetId } from '../../src/utils';
import { codec, mockGetByFields, mockStore, tupleEvent } from './helpers';

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

  /**
   * `datetime` is the row's own snapshot date and its column is not nullable, so an unreadable moment
   * is reported and the row skipped — writing null would fail the insert and take the block with it.
   * No spec version is known to omit it; this pins the two lines that treat it as optional to one
   * answer.
   */
  it('skips the row and records an anomaly when the moment does not read', async () => {
    const db = mockStore();
    const anomaly = jest.spyOn(IndexerAnomaly.prototype, 'save').mockResolvedValue(undefined);

    await handleCheckpointCreated(
      tupleEvent({
        section: 'checkpoint',
        method: 'CheckpointCreated',
        data: [
          codec(TEST_DID),
          codec(RAW_ASSET_ID),
          codec(5),
          codec(1_000_000),
          // an empty Moment: what `getDateValue` reads as absent
          codec(''),
        ],
      })
    );

    // nothing was written at all: the store never saw a Checkpoint
    expect(db.Checkpoint).toBeUndefined();
    expect(anomaly).toHaveBeenCalled();
  });

  /**
   * `CheckpointCreated` names the moment but not the schedule, and two schedules can fall due at the
   * same moment — so the timestamp alone is ambiguous. The chain emits them in ascending schedule
   * order, which is what makes the pairing exact.
   */
  describe('linking the schedule that produced it', () => {
    const MOMENT = 1_700_000_000_000;

    const params = (checkpointId: number, did: unknown) => [
      did,
      codec(RAW_ASSET_ID),
      codec(checkpointId),
      codec(1_000),
      codec(MOMENT),
    ];

    const created = (checkpointId: number, did: unknown, idx: number, events: unknown[] = []) =>
      tupleEvent({
        section: 'checkpoint',
        method: 'CheckpointCreated',
        data: params(checkpointId, did),
        idx,
        events,
      });

    /** The block's own event list, which is what the schedule pairing counts its position against. */
    const inBlock = (...emitted: [number, unknown][]) =>
      emitted.map(([checkpointId, did]) => ({
        event: {
          section: 'checkpoint',
          method: 'CheckpointCreated',
          data: params(checkpointId, did),
        },
      }));

    const seedSchedules = async (assetId: string) => {
      const db = mockStore({
        CheckpointSchedule: {
          [`${assetId}/3`]: {
            id: `${assetId}/3`,
            assetId,
            scheduleId: 3,
            scheduledCheckpoints: [new Date(MOMENT)],
          },
          [`${assetId}/1`]: {
            id: `${assetId}/1`,
            assetId,
            scheduleId: 1,
            scheduledCheckpoints: [new Date(MOMENT)],
          },
        },
      });
      mockGetByFields(db, ['CheckpointSchedule', 'Checkpoint']);

      return db;
    };

    it('assigns two schedules due at one moment in ascending schedule order', async () => {
      const assetId = await assetIdAt(8_000_000);
      const db = await seedSchedules(assetId);
      // Both fall due in the same block, which is what makes the position exact.
      const records = inBlock([5, codec(undefined)], [6, codec(undefined)]);

      await handleCheckpointCreated(created(5, codec(undefined), 0, records));
      await handleCheckpointCreated(created(6, codec(undefined), 1, records));

      expect(db.Checkpoint[`${assetId}/5`].scheduleId).toBe(`${assetId}/1`);
      expect(db.Checkpoint[`${assetId}/6`].scheduleId).toBe(`${assetId}/3`);
    });

    /**
     * A list of timestamps round-trips through the store as JSON, so the `Date`s written on the way
     * in come back out as ISO strings. That is the shape the pairing sees on a live index, and a
     * comparison that assumed a `Date` threw on the first schedule that declared its own moments.
     */
    it('pairs a schedule whose moments came back from the store as strings', async () => {
      const assetId = await assetIdAt(8_000_000);
      const db = mockStore({
        CheckpointSchedule: {
          [`${assetId}/1`]: {
            id: `${assetId}/1`,
            assetId,
            scheduleId: 1,
            scheduledCheckpoints: [new Date(MOMENT).toISOString()],
          },
        },
      });
      mockGetByFields(db, ['CheckpointSchedule', 'Checkpoint']);

      await handleCheckpointCreated(created(5, codec(undefined), 0));

      expect(db.Checkpoint[`${assetId}/5`].scheduleId).toBe(`${assetId}/1`);
    });

    it('leaves a manually created checkpoint unlinked', async () => {
      const assetId = await assetIdAt(8_000_000);
      const db = await seedSchedules(assetId);

      await handleCheckpointCreated(created(5, codec(TEST_DID), 0));

      expect(db.Checkpoint[`${assetId}/5`].scheduleId).toBeUndefined();
    });

    /**
     * A pre-v6 schedule carries a period, a start and a count — never the moments themselves — so a
     * checkpoint from that era has nothing to be paired against. Left unlinked, and silently: one
     * anomaly per scheduled checkpoint across the whole pre-v6 range would be noise, not a finding.
     */
    it('leaves a pre-v6 scheduled checkpoint unlinked without reporting it', async () => {
      const assetId = await assetIdAt(8_000_000);
      const db = mockStore({
        CheckpointSchedule: {
          [`${assetId}/1`]: {
            id: `${assetId}/1`,
            assetId,
            scheduleId: 1,
            period: '{"unit":"Month","amount":1}',
            remaining: 4,
          },
        },
      });
      mockGetByFields(db, ['CheckpointSchedule', 'Checkpoint']);
      const anomaly = jest.spyOn(IndexerAnomaly.prototype, 'save').mockResolvedValue(undefined);

      await handleCheckpointCreated(created(5, codec(undefined), 0));

      expect(db.Checkpoint[`${assetId}/5`].scheduleId).toBeUndefined();
      expect(anomaly).not.toHaveBeenCalled();
    });

    it('records an anomaly and leaves it null when a declaring schedule does not match', async () => {
      const assetId = await assetIdAt(8_000_000);
      const db = mockStore({
        CheckpointSchedule: {
          [`${assetId}/1`]: {
            id: `${assetId}/1`,
            assetId,
            scheduleId: 1,
            // declares a different moment, so the pairing genuinely fails
            scheduledCheckpoints: [new Date(MOMENT + 60_000)],
          },
        },
      });
      mockGetByFields(db, ['CheckpointSchedule', 'Checkpoint']);
      const anomaly = jest.spyOn(IndexerAnomaly.prototype, 'save').mockResolvedValue(undefined);

      await handleCheckpointCreated(created(5, codec(undefined), 0));

      expect(db.Checkpoint[`${assetId}/5`].scheduleId).toBeUndefined();
      expect(anomaly).toHaveBeenCalled();
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

  it('recovers the scheduleId from the nested StoredSchedule.id pre-v6 and leaves scheduledCheckpoints null', () => {
    const parsed = parseSchedule(decodeEvent(preV6Event), PRE_V6_SPEC);

    expect(parsed.scheduleId).toBe(7);
    expect(parsed.remaining).toBe(4);
    expect(parsed.nextCheckpointAt).toEqual(new Date(2_000));
    expect(parsed.scheduledCheckpoints).toBeUndefined();
  });

  it('reads scheduleId from params[2] at v6+ and leaves the period fields null', () => {
    const parsed = parseSchedule(decodeEvent(v6Event), V6_SPEC);

    expect(parsed.scheduleId).toBe(9);
    expect(parsed.scheduledCheckpoints).toEqual([new Date(3_000), new Date(4_000)]);
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
  it('creates a pre-v6 schedule with period/remaining populated and scheduledCheckpoints null', async () => {
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
    expect(schedule.scheduledCheckpoints).toBeUndefined();
  });

  it('creates a v6+ schedule with scheduledCheckpoints populated and period null, then removes it', async () => {
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

    expect(schedule.scheduledCheckpoints).toEqual([new Date(3_000)]);
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
