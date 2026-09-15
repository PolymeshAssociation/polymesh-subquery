/**
 * Shared unit-test scaffolding for handler tests — a Codec stand-in, an in-memory `store`, and
 * tuple-style / struct-style `SubstrateEvent` builders. Not a test file (no `.test.ts`), so jest
 * does not run it.
 */

import { SubstrateEvent } from '@subql/types';

export const storeGet = (): jest.Mock => (globalThis as any).store.get as jest.Mock;
export const storeSet = (): jest.Mock => (globalThis as any).store.set as jest.Mock;
export const storeRemove = (): jest.Mock => (globalThis as any).store.remove as jest.Mock;
export const storeGetByFields = (): jest.Mock => (globalThis as any).store.getByFields as jest.Mock;
export const storeBulkCreate = (): jest.Mock => (globalThis as any).store.bulkCreate as jest.Mock;
export const storeBulkUpdate = (): jest.Mock => (globalThis as any).store.bulkUpdate as jest.Mock;

/** Minimal Codec stand-in — handlers only read `toString` / `toJSON` / `isEmpty`. */
export const codec = (value: unknown, opts: { isEmpty?: boolean } = {}) => ({
  isEmpty: opts.isEmpty ?? (value === undefined || value === null),
  toString: () => (typeof value === 'string' ? value : JSON.stringify(value)),
  toJSON: () => value,
});

export type MockDb = Record<string, Record<string, any>>;

/**
 * Points `store.get` / `set` / `remove` at an in-memory object and returns it, and clears
 * `api.query`. Call from `beforeEach` — jest resets mocks between tests.
 */
export const mockStore = (db: MockDb = {}): MockDb => {
  storeGet().mockImplementation((entity: string, id: string) => Promise.resolve(db[entity]?.[id]));
  storeSet().mockImplementation((entity: string, id: string, data: unknown) => {
    db[entity] ??= {};
    db[entity][id] = { ...(data as object) };
    return Promise.resolve();
  });
  storeRemove().mockImplementation((entity: string, id: string) => {
    delete db[entity]?.[id];
    return Promise.resolve();
  });
  (globalThis as any).api.query = {};
  return db;
};

/**
 * Baseline chain reads `ledgerAccount`/`getOrCreateAccount` needs to create an `Account` row for
 * an address the indexer hasn't linked to an identity yet: `identity.keyRecords` reporting "no
 * record" and `api.registry.chainSS58` for key-type detection. `mockStore` doesn't set these up on
 * its own — most handlers never touch `ledgerAccount` — so any handler that does (directly, or via
 * `getOrCreatePosition`/`getOrCreateValidator`) needs a test to call this too, merging its result
 * into a fuller `api.query` mock: `{ ...mockLedgerAccountQuery(), staking: {...} }`.
 *
 * Returns a fresh object each call — `resetMocks: true` wipes a `jest.fn()`'s implementation
 * before every test, so a mock built once at module scope would already be empty by the time a
 * test uses it.
 */
export const mockLedgerAccountQuery = (): { identity: { keyRecords: jest.Mock } } => {
  (globalThis as any).api.registry = { chainSS58: 12 };

  return { identity: { keyRecords: jest.fn().mockResolvedValue({ isEmpty: true }) } };
};

/**
 * Wires `store.getByFields` — used by `getAllByFields` — to read live from the same in-memory
 * `db` `mockStore` writes to, with a working `.save()` on each returned row. `store.get`'s wiring
 * above gives `Entity.get(id).save()` this for free; `store.getByFields` is a different store
 * primitive and needs it done explicitly for any handler that fetches a set and mutates it (the
 * "replace by diff" pattern — close rows no longer present, leave matching ones alone).
 *
 * Ignores the filter expression and returns every row for `entityName` — fine for a test db
 * seeded with only the rows one query cares about; a handler diffing a mixed set needs its own
 * filtering, same as production code does after the store read.
 */
export const mockGetByFields = (db: MockDb, entityName: string): void => {
  storeGetByFields().mockImplementation((name: string) => {
    if (name !== entityName) {
      return Promise.resolve([]);
    }

    const rows = Object.values(db[entityName] ?? {}).map((raw: object) => {
      const row: any = { ...raw };

      row.save = () => {
        const data = { ...row };
        delete data.save;
        db[entityName][row.id] = data;
        return Promise.resolve();
      };

      return row;
    });

    return Promise.resolve(rows);
  });
};

/**
 * Wires `store.bulkCreate`/`store.bulkUpdate` to write each entity in the array into the same
 * in-memory `db` `mockStore` writes to — by default `setupJest.ts` mocks both as no-ops, so a
 * handler that switched from individual `.save()` calls to a bulk write would otherwise leave a
 * test's `db.<Entity>[id]` assertions seeing nothing.
 */
export const mockBulkWrites = (db: MockDb, entityName: string): void => {
  const writeAll = (name: string, rows: { id: string }[]) => {
    if (name !== entityName) {
      return Promise.resolve();
    }

    db[entityName] ??= {};
    rows.forEach(row => {
      db[entityName][row.id] = { ...row };
    });

    return Promise.resolve();
  };

  storeBulkCreate().mockImplementation(writeAll);
  storeBulkUpdate().mockImplementation(writeAll);
};

/** Field metadata for a Polymesh tuple event — unnamed, so decode falls to the shape table. */
const unnamedMeta = (length: number) => ({
  fields: Array.from({ length }, () => ({
    name: { isSome: false },
    typeName: { isSome: true, unwrap: () => codec('Dummy') },
  })),
});

export interface TupleEventOptions {
  section: string;
  method: string;
  data: unknown[];
  specVersion?: number;
  blockNumber?: string;
  idx?: number;
  extrinsic?: unknown;
  events?: unknown[];
}

/** A tuple-style `SubstrateEvent` for handler tests. */
export const tupleEvent = ({
  section,
  method,
  data,
  specVersion = 8_000_000,
  blockNumber = '1000',
  idx = 0,
  extrinsic,
  events = [],
}: TupleEventOptions): SubstrateEvent =>
  ({
    idx,
    extrinsic,
    block: {
      block: { header: { number: { toString: () => blockNumber } } },
      specVersion,
      timestamp: new Date('2026-01-01T00:00:00Z'),
      events,
    },
    event: { section, method, data, meta: unnamedMeta(data.length) },
  } as unknown as SubstrateEvent);

export interface NamedEventOptions {
  section: string;
  method: string;
  fields: Record<string, unknown>;
  specVersion?: number;
  blockNumber?: string;
  idx?: number;
  extrinsic?: unknown;
  events?: unknown[];
}

/**
 * A struct-style `SubstrateEvent` for handler tests — the block's own metadata names every
 * field, so `decodeEvent` resolves it without touching the registered shape table. This is the
 * shape every v8+ upstream Substrate pallet emits (`staking`, `balances`, …); use `tupleEvent`
 * for a Polymesh pallet's own tuple-style events instead.
 */
export const namedEvent = ({
  section,
  method,
  fields,
  specVersion = 8_000_000,
  blockNumber = '1000',
  idx = 0,
  extrinsic,
  events = [],
}: NamedEventOptions): SubstrateEvent =>
  ({
    idx,
    extrinsic,
    block: {
      block: { header: { number: { toString: () => blockNumber } } },
      specVersion,
      timestamp: new Date('2026-01-01T00:00:00Z'),
      events,
    },
    event: {
      section,
      method,
      data: Object.values(fields).map(value => codec(value)),
      meta: {
        fields: Object.keys(fields).map(name => ({
          name: { isSome: true, unwrap: () => codec(name) },
          typeName: { isSome: true, unwrap: () => codec('Dummy') },
        })),
      },
    },
  } as unknown as SubstrateEvent);

/** `PortfolioId` codec: `{ did, kind: { user: n } | { default: null } }`. */
export const portfolioCodec = (did: string, number = 0) =>
  codec({ did, kind: number ? { user: number } : { default: null } });

/** `AssetHolder` codec wrapping a portfolio: `{ portfolio: { did, kind } }`. */
export const meshPortfolioHolderCodec = (did: string, number = 0) =>
  codec({ portfolio: { did, kind: number ? { user: number } : { default: null } } });
