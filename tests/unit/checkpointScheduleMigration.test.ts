/**
 * 6.0's checkpoint migration turned each schedule the chain held, a period and a count, into the
 * moments it would fire at: from its start, at most 10 of them, and 10 for one that never ended.
 */
import {
  migrateStoredSchedules,
  scheduleMoments,
} from '../../src/mappings/migrations/checkpointScheduleMigration';
import { mockStore } from './helpers';
import { sandboxDate } from './sandbox';

const at = (iso: string) => Date.parse(iso);

describe('scheduleMoments', () => {
  it('steps a fixed period from the start, to the second, as testnet 6.0 did for ACME3', () => {
    expect(scheduleMoments(1_640_011_451_564, { unit: 'Week', amount: 4 }, 3)).toEqual([
      1_640_011_451_564, 1_642_430_651_000, 1_644_849_851_000,
    ]);
  });

  it('keeps a month to its last day when the start day is past it', () => {
    expect(scheduleMoments(at('2024-01-31T10:00:00Z'), { unit: 'Month', amount: 1 }, 3)).toEqual([
      at('2024-01-31T10:00:00Z'),
      at('2024-02-29T10:00:00Z'),
      at('2024-03-31T10:00:00Z'),
    ]);
  });

  it('keeps a 29 February start to the 28th in a year that has none', () => {
    expect(scheduleMoments(at('2024-02-29T00:00:00Z'), { unit: 'Year', amount: 1 }, 2)).toEqual([
      at('2024-02-29T00:00:00Z'),
      at('2025-02-28T00:00:00Z'),
    ]);
  });

  it('gives 10 moments to a schedule that never ends, and to one with more left', () => {
    const daily = { unit: 'Day', amount: 1 };
    expect(scheduleMoments(at('2023-01-01T00:00:00Z'), daily, 0)).toHaveLength(10);
    expect(scheduleMoments(at('2023-01-01T00:00:00Z'), daily, 25)).toHaveLength(10);
  });

  it('gives a one-off schedule its start alone', () => {
    expect(scheduleMoments(at('2022-11-21T08:05:00Z'), { unit: 'Second', amount: 0 }, 0)).toEqual([
      at('2022-11-21T08:05:00Z'),
    ]);
  });
});

const schedule = (id: string, fields: Record<string, unknown>) => ({
  id,
  assetId: '0xacme',
  scheduleId: Number(id.split('/')[1]),
  ...fields,
});

it('turns each live pre-6.0 schedule into its moments, and leaves the rest', async () => {
  const pre6 = {
    period: JSON.stringify({ unit: 'Week', amount: 4 }),
    start: new Date(1_640_011_451_564),
    remaining: 3,
    nextCheckpointAt: new Date(1_640_011_451_000),
  };
  const db = mockStore({
    CheckpointSchedule: {
      '0xacme/1': schedule('0xacme/1', pre6),
      '0xacme/2': schedule('0xacme/2', { ...pre6, removedEventId: '0008000000/0000000001' }),
      '0xacme/3': schedule('0xacme/3', { ...pre6, completedEventId: '0008000000/0000000001' }),
      '0xacme/4': schedule('0xacme/4', { scheduledCheckpoints: [new Date(1_800_000_000_000)] }),
    },
  });
  await migrateStoredSchedules();

  expect(db.CheckpointSchedule['0xacme/1']).toMatchObject({
    scheduledCheckpoints: [
      new Date(1_640_011_451_564),
      new Date(1_642_430_651_000),
      new Date(1_644_849_851_000),
    ],
  });
  for (const field of ['period', 'start', 'remaining', 'nextCheckpointAt']) {
    expect(db.CheckpointSchedule['0xacme/1'][field]).toBeUndefined();
  }
  for (const id of ['0xacme/2', '0xacme/3']) {
    expect(db.CheckpointSchedule[id]).toMatchObject({ remaining: 3 });
    expect(db.CheckpointSchedule[id].scheduledCheckpoints).toBeUndefined();
  }
  expect(db.CheckpointSchedule['0xacme/4'].scheduledCheckpoints).toEqual([
    new Date(1_800_000_000_000),
  ]);
});

it("keeps the start's milliseconds when the store's date comes through the sandbox, as ACME3's did", async () => {
  const db = mockStore({
    CheckpointSchedule: {
      '0xacme/1': schedule('0xacme/1', {
        period: JSON.stringify({ unit: 'Week', amount: 4 }),
        start: sandboxDate(1_640_011_451_564),
        remaining: 3,
      }),
    },
  });
  await migrateStoredSchedules();

  expect(db.CheckpointSchedule['0xacme/1'].scheduledCheckpoints[0]).toEqual(
    new Date(1_640_011_451_564)
  );
});
