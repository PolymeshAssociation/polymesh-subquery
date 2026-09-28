import { SubstrateEvent } from '@subql/types';
import { DecodedEvent, decodeEvent, V6 } from '../../../decode';
import { AnomalyKind, Checkpoint, CheckpointSchedule } from '../../../types';
import {
  getAllByFields,
  getAssetId,
  getBigIntValue,
  getDateValue,
  getNumberValue,
  specVersionOf,
} from '../../../utils';
import { recordAnomaly } from '../../../utils/anomaly';
import { extractArgs, getOrAnomaly } from '../common';

interface ParsedSchedule {
  scheduleId: number;
  scheduledCheckpoints?: Date[];
  period?: string;
  start?: Date;
  remaining?: number;
  nextCheckpointAt?: Date;
}

interface StoredScheduleJson {
  schedule: { start: number; period: { unit: string; amount: number } };
  id: number;
  at: number;
  remaining: number;
}

interface ScheduleCheckpointsJson {
  pending: number[];
}

/**
 * `ScheduleCreated` / `ScheduleRemoved` are the one real version change in the corporate-actions
 * domain: arity 3 → 4 at v6.0.0, `ScheduleId` inserted at index 2 and the payload type changing
 * from `StoredSchedule` (period-based) to `ScheduleCheckpoints` (an explicit timestamp list). The
 * pre-v6 schedule id is recoverable from the nested `StoredSchedule.id`, so pre-v6 rows are not
 * lossy, just decoded differently. Exported as a pure function for the arity regression test.
 */
export const parseSchedule = (decoded: DecodedEvent, specVersion: number): ParsedSchedule => {
  if (specVersion < V6) {
    const stored = decoded.storedSchedule.toJSON() as unknown as StoredScheduleJson;

    return {
      scheduleId: stored.id,
      period: JSON.stringify(stored.schedule.period),
      start: new Date(stored.schedule.start),
      remaining: stored.remaining,
      nextCheckpointAt: new Date(stored.at),
    };
  }

  const { pending } = decoded.scheduleCheckpoints.toJSON() as unknown as ScheduleCheckpointsJson;

  return {
    scheduleId: getNumberValue(decoded.scheduleId),
    scheduledCheckpoints: pending.map(moment => new Date(moment)),
  };
};

/**
 * The schedule that produced a scheduled checkpoint, resolved from the index rather than the chain.
 *
 * `CheckpointCreated` names the moment but not the schedule, and two schedules can fall due at the
 * same moment — so the timestamp alone is ambiguous and the order is what resolves it. The chain
 * processes schedules in ascending `ScheduleId` and, within one, its moments in ascending order, so
 * the events arrive in that order too. Taking the lowest-numbered schedule that declared this moment
 * and has not yet had a checkpoint linked to it therefore assigns them one-to-one: the first event
 * claims the first schedule, the next claims the next.
 *
 * `SchedulePoints` would answer this directly, but it is a chain read per checkpoint; the index
 * already holds everything needed. An unresolvable pairing is recorded and left null rather than
 * guessed at.
 */
const scheduleForCheckpoint = async (
  assetId: string,
  moment: Date,
  event: SubstrateEvent
): Promise<string | undefined> => {
  const schedules = await getAllByFields<CheckpointSchedule>('CheckpointSchedule', [
    ['assetId', '=', assetId],
  ]);

  /**
   * Pre-v6 schedules do not enumerate their moments — they carry a period, a start and a count, and
   * the chain advances them as balances change. So there is nothing to pair a moment against, and a
   * checkpoint from that era is left unlinked without comment: unpairable by construction is not the
   * same as unexpected, and reporting it would mean one anomaly per scheduled checkpoint for the
   * whole pre-v6 range.
   */
  const declaring = schedules.filter(({ scheduledCheckpoints }) => scheduledCheckpoints?.length);

  if (declaring.length === 0) {
    return undefined;
  }

  const candidates = declaring
    .filter(({ scheduledCheckpoints }) =>
      scheduledCheckpoints.some(declared => declared.getTime() === moment.getTime())
    )
    .sort((a, b) => a.scheduleId - b.scheduleId);

  // One read for the asset's checkpoints rather than one per candidate: whichever schedules are
  // already spoken for at this moment are the ones an earlier event in the same batch claimed.
  const existing = await getAllByFields<Checkpoint>('Checkpoint', [['assetId', '=', assetId]]);

  const claimed = new Set(
    existing
      .filter(({ datetime, scheduleId }) => scheduleId && datetime.getTime() === moment.getTime())
      .map(({ scheduleId }) => scheduleId)
  );

  const unclaimed = candidates.find(({ id }) => !claimed.has(id));

  if (unclaimed) {
    return unclaimed.id;
  }

  const { block, eventIdx, moduleId, eventId } = extractArgs(event);

  await recordAnomaly({
    kind: AnomalyKind.MissingReferencedEntity,
    detail: `no unclaimed CheckpointSchedule of asset ${assetId} declared the moment ${moment.toISOString()}`,
    block,
    eventIdx,
    moduleId,
    eventId,
  });

  return undefined;
};

export const handleCheckpointCreated = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const {
    assetId: rawAssetId,
    checkpointId: rawCheckpointId,
    totalSupply: rawTotalSupply,
    moment,
  } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const checkpointId = getNumberValue(rawCheckpointId);
  // The checkpoint's own moment, never the block's. A schedule only advances when the asset's
  // balances change, so a checkpoint's moment can predate the block that created it by some
  // margin — substituting the block time would quietly move the balance snapshot's date.
  const datetime = getDateValue(moment);

  // `CheckpointCreated`'s first arg is `Option<IdentityId>`: `Some` for a manual
  // `checkpoint.createCheckpoint`, `None` only when a schedule triggered it. A manual checkpoint
  // belongs to no schedule, so it skips the lookup entirely.
  const scheduled = decodeEvent(event).did.isEmpty;

  await Checkpoint.create({
    id: `${assetId}/${checkpointId}`,
    assetId,
    checkpointId,
    totalSupply: getBigIntValue(rawTotalSupply),
    datetime,
    scheduleId:
      scheduled && datetime ? await scheduleForCheckpoint(assetId, datetime, event) : undefined,
    createdEventId: blockEventId,
  }).save();
};

export const handleScheduleCreated = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const decoded = decodeEvent(event);
  const { assetId: rawAssetId } = decoded;

  const assetId = await getAssetId(rawAssetId, block);
  const parsed = parseSchedule(decoded, specVersionOf(block));

  await CheckpointSchedule.create({
    id: `${assetId}/${parsed.scheduleId}`,
    assetId,
    scheduleId: parsed.scheduleId,
    scheduledCheckpoints: parsed.scheduledCheckpoints,
    period: parsed.period,
    start: parsed.start,
    remaining: parsed.remaining,
    nextCheckpointAt: parsed.nextCheckpointAt,
    createdEventId: blockEventId,
  }).save();
};

export const handleScheduleRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const decoded = decodeEvent(event);
  const { assetId: rawAssetId } = decoded;

  const assetId = await getAssetId(rawAssetId, block);
  const { scheduleId } = parseSchedule(decoded, specVersionOf(block));

  const schedule = await getOrAnomaly(
    id => CheckpointSchedule.get(id),
    `${assetId}/${scheduleId}`,
    'CheckpointSchedule',
    event
  );

  if (!schedule) {
    return;
  }

  schedule.removedEventId = blockEventId;

  await schedule.save();
};
