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
 * A moment as a comparable number, whatever shape the store handed back.
 *
 * A list of timestamps is held as a JSON array, so the `Date`s written on the way in come back out
 * as ISO strings — only a column-typed timestamp, like a checkpoint's own `datetime`, round-trips as
 * a `Date`. Both kinds are compared here, so both are widened rather than trusted to be `Date`s.
 */
const momentValue = (moment: Date | string): number =>
  moment instanceof Date ? moment.getTime() : new Date(moment).getTime();

/**
 * How many scheduled checkpoints for the same asset and moment the chain already announced earlier
 * in this block.
 *
 * Every schedule due at one moment fires in the same block, in ascending `ScheduleId`, so this count
 * is the checkpoint's position among the schedules that declared that moment. Reading it from the
 * block's own event list costs nothing, where asking the store which schedules were already spoken
 * for meant loading every checkpoint the asset has ever had — quadratic over the lifetime of an asset
 * on a daily schedule. Scanning sibling events in the same block has precedent in the settlement and
 * NFT handlers.
 *
 * `CheckpointCreated` carries `(Option<IdentityId>, AssetId, CheckpointId, Balance, Moment)`, and the
 * raw parameters are compared rather than the resolved ids: siblings in one block share an encoding,
 * so comparing them as emitted is exact and needs no asset-id resolution per sibling.
 */
const earlierScheduledCheckpoints = (event: SubstrateEvent): number => {
  const records = (event.block.events ?? []) as unknown as {
    event: { section: string; method: string; data: { toString(): string; isEmpty: boolean }[] };
  }[];

  const own = records[event.idx]?.event?.data;

  if (!own) {
    return 0;
  }

  let earlier = 0;

  for (let i = 0; i < event.idx; i += 1) {
    const emitted = records[i]?.event;

    if (
      emitted?.section === 'checkpoint' &&
      emitted.method === 'CheckpointCreated' &&
      // scheduled, not a manual `createCheckpoint`, which belongs to no schedule
      emitted.data[0]?.isEmpty &&
      emitted.data[1]?.toString() === own[1]?.toString() &&
      emitted.data[4]?.toString() === own[4]?.toString()
    ) {
      earlier += 1;
    }
  }

  return earlier;
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
      (scheduledCheckpoints ?? []).some(declared => momentValue(declared) === momentValue(moment))
    )
    .sort((a, b) => a.scheduleId - b.scheduleId);

  const paired = candidates[earlierScheduledCheckpoints(event)];

  if (paired) {
    return paired.id;
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
    scheduleId: scheduled ? await scheduleForCheckpoint(assetId, datetime, event) : undefined,
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
