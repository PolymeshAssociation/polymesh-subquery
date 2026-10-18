import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { findStorage } from '../utils/legacyQuery';
import { storageAtParent } from '../utils/storageAtParent';
import { entryKey, readManyAtParent, ScannedEntry, scanAtParent } from './bulk';
import { shapeOf } from './shapes';
import SHAPES from './knownShapes.json';

/** A storage item as `section.item`, such as `staking.ledger` */
export type StorageRef = `${string}.${string}`;

export type Entry = ScannedEntry;

/**
 * The chain state a seed reads: storage as it stood when the start block began. Each item is
 * fetched at most once, whichever seeders ask for it, and checked first against the shapes the
 * seeders declare (`knownShapes.json`), so a runtime that changed an item's shape stops the seed instead
 * of being misread.
 */
export interface ChainSnapshot {
  readonly block: SubstrateBlock;
  /** whether this runtime has the item */
  has(item: StorageRef): boolean;
  /** every entry of the item, keyed by its key arguments joined by `/` (`entryKey`) */
  map(item: StorageRef): Promise<ReadonlyMap<string, Entry>>;
  /** the item's entries a page at a time, or those under leading key arguments `prefix` */
  pages(item: StorageRef, ...prefix: unknown[]): AsyncIterable<Entry[]>;
  /** the values of known keys */
  many(item: StorageRef, keys: unknown[][]): Promise<(Codec | undefined)[]>;
  /** a plain item's value */
  value(item: StorageRef): Promise<Codec | undefined>;
  /** a view several seeders share, such as items joined by key, built once per seed */
  derive<T>(name: string, build: () => Promise<T>): Promise<T>;
  /** how many of the item's values read so far don't decode with the block's registry */
  undecodable(item: StorageRef): number;
}

export class UnsupportedShapeError extends Error {
  constructor(item: string, shape: string, specVersion: number) {
    super(
      `${item} holds entries in a shape no seeder reads (${shape}) at spec ${specVersion}; a seeder has to learn it first`
    );
    this.name = 'UnsupportedShapeError';
  }
}

const PAGE = 1000;

const split = (item: StorageRef): [string, string] => item.split('.') as [string, string];

export const snapshotAtParent = (
  block: SubstrateBlock,
  shapes: Record<string, string[]> = SHAPES
): ChainSnapshot => {
  const checked = new Map<string, Promise<void>>();
  const maps = new Map<string, Promise<ReadonlyMap<string, Entry>>>();
  const derived = new Map<string, Promise<unknown>>();
  const undecodable = new Map<StorageRef, number>();
  // the scan returns only keys that exist, so an entry with no value is one that doesn't decode
  const counted = (item: StorageRef, page: Entry[]): Entry[] => {
    const failed = page.filter(({ value }) => !value).length;
    if (failed) {
      undecodable.set(item, (undecodable.get(item) ?? 0) + failed);
    }
    return page;
  };

  /** Whether the item holds any entry: its first page, the scan closed after it */
  const isPopulated = async (item: StorageRef): Promise<boolean> => {
    const scan = scanAtParent(block, ...split(item));
    const first = await scan.next();
    await scan.return(undefined);
    return !first.done && first.value.length > 0;
  };

  const check = (item: StorageRef): Promise<void> => {
    let done = checked.get(item);
    if (!done) {
      done = (async () => {
        if (!(item in shapes)) {
          throw new Error(`no seeder declares a read of ${item}`);
        }
        const storage = findStorage(...split(item));
        if (!storage) {
          return;
        }
        const shape = shapeOf(storage);
        if (!shapes[item].includes(shape) && (await isPopulated(item))) {
          throw new UnsupportedShapeError(item, shape, block.specVersion);
        }
      })();
      checked.set(item, done);
    }
    return done;
  };

  const map = (item: StorageRef): Promise<ReadonlyMap<string, Entry>> => {
    let whole = maps.get(item);
    if (!whole) {
      whole = (async () => {
        await check(item);
        const entries = new Map<string, Entry>();
        for await (const page of scanAtParent(block, ...split(item))) {
          counted(item, page).forEach(entry => entries.set(entryKey(entry.args), entry));
        }
        return entries;
      })();
      maps.set(item, whole);
    }
    return whole;
  };

  return {
    block,
    has: item => Boolean(findStorage(...split(item))),
    map,
    async *pages(item, ...prefix) {
      await check(item);
      const whole = prefix.length === 0 ? maps.get(item) : undefined;
      if (whole === undefined) {
        for await (const page of scanAtParent(block, ...split(item), ...prefix)) {
          yield counted(item, page);
        }
        return;
      }
      const entries = [...(await whole).values()];
      for (let i = 0; i < entries.length; i += PAGE) {
        yield entries.slice(i, i + PAGE);
      }
    },
    many: async (item, keys) => {
      await check(item);
      return readManyAtParent(block, ...split(item), keys);
    },
    value: async item => {
      await check(item);
      return storageAtParent(block, ...split(item));
    },
    undecodable: item => undecodable.get(item) ?? 0,
    derive: <T>(name: string, build: () => Promise<T>): Promise<T> => {
      let view = derived.get(name) as Promise<T> | undefined;
      if (!view) {
        view = build();
        derived.set(name, view);
      }
      return view;
    },
  };
};
