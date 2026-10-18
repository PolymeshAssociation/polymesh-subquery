import { SubstrateBlock } from '@subql/types';
import { byCodeUnit } from '../utils/order';
import { ChainSnapshot, StorageRef } from './snapshot';

/** What a seed knows of where it runs: the start block and the seed `Event` rows point at */
export interface SeedContext {
  block: SubstrateBlock;
  blockId: string;
  /** the seed `Event`'s id, every seeded row's provenance */
  eventId: string;
  datetime: Date;
  specVersion: number;
}

/** A row as a seeder builds it: a model's attributes, written with `store.bulkCreate` */
export type SeedRow = { id: string };

/**
 * One entity's seed: its rows built from the chain state the start block began from, and nothing
 * else. A seeder reads only the snapshot, never the store or the RPC, so its rows don't depend on
 * which seeders ran before it.
 */
export interface Seeder<T extends SeedRow = SeedRow> {
  entity: string;
  /** the storage it reads, which the snapshot holds it to and the storage survey must know */
  reads: StorageRef[];
  /** for an item it reads before 6.0, the `from` of each survey range whose shape it handles */
  oldShapes?: Partial<Record<StorageRef, number[]>>;
  rows(snap: ChainSnapshot, ctx: SeedContext): AsyncIterable<T[]>;
  /** fields the index counts from the start block, such as lifetime totals */
  relative?: string[];
  /** the fields naming an `Account`, for the account closure */
  accounts?: string[];
  /** a finished row the chain prunes, which an index keeps and a seed can't write */
  terminal?(row: T): boolean;
  /** the row this one belongs to, which the chain prunes it with once that row is finished */
  parent?: { entity: string; field: string };
}

export interface SeedOptions {
  seeders?: Seeder[];
  /** Account rows for addresses no seeded Account row covers */
  accountRows?(addresses: string[], snap: ChainSnapshot, ctx: SeedContext): Promise<SeedRow[]>;
}

export interface SeedReport {
  entity: string;
  rows: number;
  ms: number;
}

/**
 * A page's rows, its entries built together: each entry's rows come from lookups that don't depend
 * on the other entries, such as an asset id derived from a ticker. Pages stay in order.
 */
export const pageRows = async <E, T>(
  page: readonly E[],
  build: (entry: E) => Promise<T[]>
): Promise<T[]> => (await Promise.all(page.map(build))).flat();

/** How many rows a seeder writes at once */
export const SEED_PAGE = 1000;

/** Rows a seeder builds whole, in pages of `SEED_PAGE` */
export function* pagesOf<T>(rows: readonly T[]): Generator<T[]> {
  for (let i = 0; i < rows.length; i += SEED_PAGE) {
    yield rows.slice(i, i + SEED_PAGE);
  }
}

/** `Entity.field` for every field a seeder counts from the start block, sorted */
export const relativeFields = (seeders: Seeder[]): string[] =>
  seeders
    .flatMap(({ entity, relative = [] }) => relative.map(field => `${entity}.${field}`))
    .sort(byCodeUnit);

/**
 * Writes every seeder's rows, a page at a time, then an Account row for each address a seeded row
 * names that no seeded Account row covers.
 */
export const seed = async (
  snap: ChainSnapshot,
  ctx: SeedContext,
  { seeders = [], accountRows }: SeedOptions = {}
): Promise<SeedReport[]> => {
  const report: SeedReport[] = [];
  const accounts = new Set<string>();
  const named = new Set<string>();

  // one seeder at a time: a failure stops the seed before the next one writes anything, and the
  // snapshot bounds the requests in flight across every scan anyway
  for (const seeder of seeders) {
    const started = Date.now();
    let rows = 0;
    for await (const page of seeder.rows(snap, ctx)) {
      if (page.length === 0) {
        continue;
      }
      await store.bulkCreate(seeder.entity, page);
      rows += page.length;
      if (seeder.entity === 'Account') {
        page.forEach(({ id }) => accounts.add(id));
      }
      seeder.accounts?.forEach(field =>
        page.forEach(row => {
          const address = (row as unknown as Record<string, unknown>)[field];
          if (typeof address === 'string' && address) {
            named.add(address);
          }
        })
      );
    }
    const ms = Date.now() - started;
    logger.info(`Seeded ${rows} ${seeder.entity} rows in ${ms} ms`);
    report.push({ entity: seeder.entity, rows, ms });
  }

  const uncovered = [...named].filter(address => !accounts.has(address));
  if (uncovered.length && accountRows) {
    const rows = await accountRows(uncovered, snap, ctx);
    await store.bulkCreate('Account', rows);
    report.push({ entity: 'Account (named by other rows)', rows: rows.length, ms: 0 });
  }

  return report;
};
