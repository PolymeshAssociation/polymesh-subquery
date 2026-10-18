import { shapeKey, StorageShape } from '../../src/seed/shapes';
import { Seeder } from '../../src/seed/seeder';
import { byCodeUnit } from '../../src/utils/order';

type Range = StorageShape & { from: number; to: number | null };
export type StorageHistory = Record<string, { ranges: Range[] }>;

/** The first runtime whose shapes every seeder reads without saying so */
export const SHAPES_FROM = 6_000_000;

/**
 * The shapes the seeders read, per item: each surveyed range from 6.0 on, and each older range a
 * seeder names in `oldShapes`. `src/seed/shapes.json` is this, written by `yarn seed:shapes`.
 */
export const seedShapes = (
  seeders: Seeder[],
  history: StorageHistory
): Record<string, string[]> => {
  const shapes: Record<string, Set<string>> = {};
  for (const { reads, oldShapes = {} } of seeders) {
    for (const item of reads) {
      const older = oldShapes[item] ?? [];
      const known = (shapes[item] ??= new Set());
      (history[item]?.ranges ?? [])
        .filter(({ from }) => from >= SHAPES_FROM || older.includes(from))
        .forEach(range => known.add(shapeKey(range)));
    }
  }
  return Object.fromEntries(
    Object.keys(shapes)
      .sort(byCodeUnit)
      .map(item => [item, [...shapes[item]].sort(byCodeUnit)])
  );
};
