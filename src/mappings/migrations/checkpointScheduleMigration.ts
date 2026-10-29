import { CheckpointSchedule } from '../../types';
import { getAllByFields } from '../../utils';

/**
 * What 6.0's checkpoint migration (`migrate_to_v1`) did with no event: each schedule the chain held,
 * a period and a count, became the moments it would fire at, `ScheduleCheckpoints::from_old`. They
 * run from the schedule's start, even for one that had fired already, and number its remaining count
 * up to 10, or 10 for one that never ended. The index holds the start, period and count it read.
 */

interface CalendarPeriod {
  unit: string;
  amount: number;
}

const MAX_MOMENTS = 10;

const SECONDS_IN: Record<string, number> = {
  Second: 1,
  Minute: 60,
  Hour: 3_600,
  Day: 86_400,
  Week: 604_800,
};

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

/** The days in a month, 0-indexed */
const daysIn = (year: number, month0: number): number => {
  if ([3, 5, 8, 10].includes(month0)) {
    return 30;
  }
  if (month0 === 1) {
    return isLeapYear(year) ? 29 : 28;
  }
  return 31;
};

/** The start's date moved to `year` and 0-indexed `month0`, its day kept within the month */
const onDate = (start: Date, year: number, month0: number, day: number): number =>
  Date.UTC(
    year,
    month0,
    Math.min(day, daysIn(year, month0)),
    start.getUTCHours(),
    start.getUTCMinutes(),
    start.getUTCSeconds()
  ) / 1_000;

/** The moment after `now` a period from `start` falls on, in seconds; `calendar::next_checkpoint_secs` */
const nextSecond = (start: number, period: CalendarPeriod, now: number): number | undefined => {
  if (start > now) {
    return start;
  }
  if (period.amount === 0) {
    return undefined;
  }
  const fixed = SECONDS_IN[period.unit];
  if (fixed) {
    const length = fixed * period.amount;
    return start + length * (Math.floor((now - start) / length) + 1);
  }
  const from = new Date(start * 1_000);
  const to = new Date(now * 1_000);
  const day = from.getUTCDate();
  if (period.unit === 'Month') {
    const elapsed =
      (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth();
    const month = from.getUTCMonth() + period.amount * (Math.floor(elapsed / period.amount) + 1);
    return onDate(from, from.getUTCFullYear() + Math.floor(month / 12), month % 12, day);
  }
  const elapsed = Math.trunc((to.getUTCFullYear() - from.getUTCFullYear()) / period.amount);
  return onDate(
    from,
    from.getUTCFullYear() + period.amount * (elapsed + 1),
    from.getUTCMonth(),
    day
  );
};

/** The moments, in milliseconds, 6.0 gave a schedule of `start`, `period` and `remaining` left */
export const scheduleMoments = (
  start: number,
  period: CalendarPeriod,
  remaining: number
): number[] => {
  const count = remaining === 0 ? MAX_MOMENTS : Math.min(remaining, MAX_MOMENTS);
  const moments = new Set([start]);
  let now = start;
  for (let n = 1; n < count; n += 1) {
    const second = nextSecond(Math.floor(start / 1_000), period, Math.floor(now / 1_000));
    if (second !== undefined) {
      now = second * 1_000;
      moments.add(now);
    }
  }
  return [...moments].sort((a, b) => a - b);
};

/**
 * A live schedule's period terms, as the index read them before 6.0. The start is read with
 * `getTime()`: in the sandbox, `new Date()` of a stored date reads its `toString()`, which drops the
 * milliseconds.
 */
const periodTerms = ({
  period,
  start,
  remaining,
  removedEventId,
  completedEventId,
}: CheckpointSchedule): [number, CalendarPeriod, number] | undefined =>
  period && start && !removedEventId && !completedEventId
    ? [start.getTime(), JSON.parse(period) as CalendarPeriod, remaining ?? 0]
    : undefined;

export const migrateStoredSchedules = async (): Promise<void> => {
  // read whole, once: no index covers `period`
  const schedules = await getAllByFields<CheckpointSchedule>('CheckpointSchedule', []);

  await Promise.all(
    schedules.map(schedule => {
      const terms = periodTerms(schedule);
      if (!terms) {
        return undefined;
      }
      schedule.scheduledCheckpoints = scheduleMoments(...terms).map(moment => new Date(moment));
      // the period model is gone from the chain; its count and next moment would only go stale
      schedule.period = undefined;
      schedule.start = undefined;
      schedule.remaining = undefined;
      schedule.nextCheckpointAt = undefined;
      return schedule.save();
    })
  );
};
