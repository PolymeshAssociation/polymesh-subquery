import { SubstrateEvent } from '@subql/types';
import { DecodedEvent, decodeEvent, V6 } from '../../../decode';
import { Checkpoint, CheckpointSchedule } from '../../../types';
import {
  getAssetId,
  getBigIntValue,
  getDateValue,
  getNumberValue,
  specVersionOf,
} from '../../../utils';
import { extractArgs } from '../common';

interface ParsedSchedule {
  scheduleId: number;
  pendingCheckpoints?: Date[];
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
    pendingCheckpoints: pending.map(moment => new Date(moment)),
  };
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

  await Checkpoint.create({
    id: `${assetId}/${checkpointId}`,
    assetId,
    checkpointId,
    totalSupply: getBigIntValue(rawTotalSupply),
    datetime: getDateValue(moment) ?? block.timestamp,
    // `CheckpointCreated`'s first arg is `Option<IdentityId>` — `None` when a schedule triggered
    // it, `Some` for a manual `checkpoint.createCheckpoint`. Neither case names *which* schedule,
    // so linking `schedule` here would mean scanning every schedule for this asset for a
    // matching pending timestamp — left for a future enrichment rather than guessed at.
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
    pendingCheckpoints: parsed.pendingCheckpoints,
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

  const schedule = await CheckpointSchedule.get(`${assetId}/${scheduleId}`);

  if (!schedule) {
    return;
  }

  schedule.removedEventId = blockEventId;

  await schedule.save();
};
