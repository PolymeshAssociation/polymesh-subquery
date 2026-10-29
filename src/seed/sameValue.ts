import { byCodeUnit } from '../utils/order';

type Row = Record<string, unknown>;

/**
 * Whether two values of a field are the same once both are read as the store renders them: a
 * seeded value against an indexed one, as GraphQL or the store returned it.
 */

const ISO_DATE = /^\d{4}-\d\d-\d\dT\d\d:\d\d/;

/** A value as GraphQL renders it: big numbers as strings, times in UTC, keys sorted */
const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string' && ISO_DATE.test(value)) {
    const zoned = /(Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`;
    const time = new Date(zoned);
    return Number.isNaN(time.getTime()) ? value : time.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Row)
        .sort(byCodeUnit)
        .map(key => [key, canonical((value as Row)[key])])
        .filter(([, inner]) => inner !== null)
    );
  }
  return value;
};

/** A number as text, the form GraphQL gives a big one in; `undefined` for anything else */
const numberText = (value: unknown): string | undefined =>
  typeof value === 'number' || typeof value === 'string' ? String(value) : undefined;

/** Whether a seeded value and an indexed one are the same */
export const sameValue = (seeded: unknown, indexed: unknown): boolean => {
  const [a, b] = [canonical(seeded), canonical(indexed)];
  if (typeof a === 'number' || typeof b === 'number') {
    const text = numberText(a);
    return text !== undefined && text === numberText(b);
  }
  return JSON.stringify(a) === JSON.stringify(b);
};
