import { SubstrateEvent } from '@subql/types';
import { DecodedEvent, decodeEvent, V6 } from '../../../decode';
import { AnomalyKind, Checkpoint, CheckpointSchedule } from '../../../types';
import {
  getAssetId,
  getBigIntValue,
  getDateValue,
  getNumberValue,
  specVersionOf,
} from '../../../utils';
import { recordAnomaly } from '../../../utils/anomaly';
import { extractArgs, getOrAnomaly } from '../common';
import { isObject, jsonOf } from '../../../utils/codec';

export interface ParsedSchedule {
  scheduleId: number;
  scheduledCheckpoints?: Date[];
  period?: string;
  start?: Date;
}

export interface StoredScheduleJson {
  schedule: { start: number; period: { unit: string; amount: number } };
  id: number;
  at: number;
  remaining: number;
}

interface ScheduleCheckpointsJson {
  pending: number[];
}

export const isStoredSchedule = (json: unknown): json is StoredScheduleJson =>
  isObject(json) &&
  typeof json.id === 'number' &&
  typeof json.at === 'number' &&
  typeof json.remaining === 'number' &&
  isObject(json.schedule) &&
  typeof json.schedule.start === 'number' &&
  isObject(json.schedule.period);

const isScheduleCheckpoints = (json: unknown): json is ScheduleCheckpointsJson =>
  isObject(json) &&
  Array.isArray(json.pending) &&
  json.pending.every(moment => typeof moment === 'number');

/** A pre-v6 schedule's row fields, as its event and the chain's `checkpoint.schedules` hold it */
export const storedScheduleFields = (stored: StoredScheduleJson): ParsedSchedule => ({
  scheduleId: stored.id,
  period: JSON.stringify(stored.schedule.period),
  start: new Date(stored.schedule.start),
});

/**
 * `ScheduleCreated` / `ScheduleRemoved` are the one real version change in the corporate-actions
 * domain: arity 3 → 4 at v6.0.0, `ScheduleId` inserted at index 2 and the payload type changing
 * from `StoredSchedule` (period-based) to `ScheduleCheckpoints` (an explicit timestamp list). The
 * pre-v6 schedule id is recoverable from the nested `StoredSchedule.id`, so pre-v6 rows are not
 * lossy, just decoded differently. Exported as a pure function for the arity regression test.
 */
export const parseSchedule = (decoded: DecodedEvent, specVersion: number): ParsedSchedule => {
  if (specVersion < V6) {
    return storedScheduleFields(jsonOf(decoded.storedSchedule, isStoredSchedule, 'StoredSchedule'));
  }

  const { pending } = jsonOf(decoded.schedule, isScheduleCheckpoints, 'ScheduleCheckpoints');

  return {
    scheduleId: getNumberValue(decoded.scheduleId),
    scheduledCheckpoints: pending.map(moment => new Date(moment)),
  };
};

export const handleCheckpointCreated = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const {
    assetId: rawAssetId,
    checkpointId: rawCheckpointId,
    totalSupply: rawTotalSupply,
    timestamp: moment,
  } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const checkpointId = getNumberValue(rawCheckpointId);
  // The checkpoint's own moment, never the block's. A schedule only advances when the asset's
  // balances change, so a checkpoint's moment can predate the block that created it by some
  // margin — substituting the block time would quietly move the balance snapshot's date.
  const datetime = getDateValue(moment);

  // `datetime` is the row's own snapshot date and the column is not nullable, so a moment that will
  // not read is reported and the row skipped rather than written as null — which would fail the
  // insert and take the whole block down with it. No spec version is known to omit the moment; this
  // is here so that one answer covers it, since the pairing below also has to treat it as optional.
  if (!datetime) {
    const { eventIdx, moduleId, eventId } = extractArgs(event);

    await recordAnomaly({
      kind: AnomalyKind.UnreadableValue,
      detail: `CheckpointCreated for asset ${assetId} carried no readable Moment, so checkpoint ${checkpointId} was not recorded`,
      block,
      eventIdx,
      moduleId,
      eventId,
    });

    return;
  }

  await Checkpoint.create({
    id: `${assetId}/${checkpointId}`,
    assetId,
    checkpointId,
    totalSupply: getBigIntValue(rawTotalSupply),
    datetime,
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
