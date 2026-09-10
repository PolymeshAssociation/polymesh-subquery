/**
 * Shared unit-test scaffolding for handler tests — a Codec stand-in, an in-memory `store`, and a
 * tuple-style `SubstrateEvent` builder. Not a test file (no `.test.ts`), so jest does not run it.
 */

import { SubstrateEvent } from '@subql/types';

export const storeGet = (): jest.Mock => (globalThis as any).store.get as jest.Mock;
export const storeSet = (): jest.Mock => (globalThis as any).store.set as jest.Mock;
export const storeRemove = (): jest.Mock => (globalThis as any).store.remove as jest.Mock;

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

/** `PortfolioId` codec: `{ did, kind: { user: n } | { default: null } }`. */
export const portfolioCodec = (did: string, number = 0) =>
  codec({ did, kind: number ? { user: number } : { default: null } });

/** `AssetHolder` codec wrapping a portfolio: `{ portfolio: { did, kind } }`. */
export const meshPortfolioHolderCodec = (did: string, number = 0) =>
  codec({ portfolio: { did, kind: number ? { user: number } : { default: null } } });
