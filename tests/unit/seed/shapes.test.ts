/**
 * The shape the seed checks an item against is the one the storage survey recorded for that
 * runtime: the live registry, built with the chain's type bundle, describes it the same way as the
 * survey's metadata-only one.
 */
import history from '../../fixtures/storage-history.json';
import { shapeKey, shapeOf } from '../../../src/seed/shapes';
import { findStorage } from '../../../src/utils/legacyQuery';
import { fakeChain } from './fakeChain';

type Range = {
  from: number;
  to: number | null;
  keys: string[];
  value: string;
  hashers: string[];
  chains: string[];
};
const items = history as unknown as Record<string, { ranges: Range[] }>;

const rangeAt = (item: string, spec: number): Range | undefined =>
  items[item]?.ranges.find(r => r.from <= spec && (r.to === null || spec <= r.to));

const surveyed = (item: string, spec: number): string | undefined => {
  const range = rangeAt(item, spec);
  return range && shapeKey(range);
};

describe.each([3_001, 5_000_003, 6_002_010, 7_002_000, 8_000_020, 8_001_020])(
  'at spec %i',
  spec => {
    beforeAll(() => {
      fakeChain(spec);
    });

    it.each(Object.keys(items).filter(item => surveyed(item, spec)))(
      '%s has its surveyed shape',
      item => {
        const [section, name] = item.split('.');
        const storage = findStorage(section, name);
        // an item only one chain runs, which these metadata (one chain's) may not have
        if (!storage && (rangeAt(item, spec) as Range).chains.length < 2) {
          return;
        }

        expect(storage && shapeOf(storage)).toBe(surveyed(item, spec));
      }
    );
  }
);
