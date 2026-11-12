/**
 * A node in memory, for the seed's tests: a real registry built from a runtime's recorded metadata,
 * real storage keys and SCALE values, and the few RPC methods a seed calls. `bulk.ts` and the
 * snapshot run against it unchanged, so a test exercises the decoding a live seed does.
 */
import { expandMetadata, Metadata, TypeRegistry } from '@polkadot/types';
import { getSpecTypes } from '@polkadot/types-known';
import { compactStripLength, hexToU8a, u8aToHex } from '@polkadot/util';
import { SubstrateBlock } from '@subql/types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import chainTypes from '../../../src/chainTypes';
import { memoryStore } from '../../../scripts/lib/memoryStore';
import { byCodeUnit } from '../../../src/utils/order';

const FIXTURES = join(__dirname, '..', '..', 'fixtures');

const registryOf = (
  specName: string,
  specVersion: number,
  metadata: Uint8Array | string,
  ss58Format: number
) => {
  const registry = new TypeRegistry();
  registry.setKnownTypes({ typesBundle: chainTypes.typesBundle as never });
  registry.register(chainTypes.types as never);
  registry.register(getSpecTypes(registry, 'Polymesh', specName, specVersion));
  const decoded = new Metadata(registry, metadata as never);
  registry.setMetadata(decoded);
  registry.setChainProperties(registry.createType('ChainProperties', { ss58Format }));
  // each entry as `api.query` decorates it: the raw entry as `creator`, its keys as hex
  const query: Record<string, Record<string, unknown>> = {};
  Object.entries(expandMetadata(registry, decoded).query).forEach(([section, items]) => {
    query[section] = {};
    Object.entries(items).forEach(([name, creator]: [string, any]) => {
      query[section][name] = Object.assign(() => undefined, {
        creator,
        key: (...args: unknown[]) => u8aToHex(compactStripLength(creator(...args))[1]),
        keyPrefix: (...args: unknown[]) => u8aToHex(creator.keyPrefix(...args)),
      });
    });
  });
  return { registry, query: query as any, tx: expandMetadata(registry, decoded).tx as any };
};

export interface FakeChain {
  specVersion: number;
  registry: TypeRegistry;
  /** stores `value` (JSON a codec takes) under `item`'s key built from `args` */
  put(item: string, args: unknown[], value: unknown): void;
  /** a call of this runtime, as JSON a `Call` value takes, such as `system.remark` */
  call(section: string, method: string, ...args: unknown[]): unknown;
  /** stores raw SCALE bytes, such as a value this runtime's types can't decode */
  putRaw(item: string, args: unknown[], hex: string): void;
  /** the block a seed starts at: its parent is the stored state */
  block: SubstrateBlock;
  /** the block at `number`, its parent likewise the stored state */
  blockAt(number: number, timestamp?: Date): SubstrateBlock;
  /** what the seed wrote */
  rows(entity: string): Record<string, unknown>[];
}

const option = (registry: TypeRegistry, hex: string | undefined) =>
  hex === undefined
    ? {
        isSome: false,
        isNone: true,
        isEmpty: true,
        unwrap: () => {
          throw new Error('None');
        },
      }
    : {
        isSome: true,
        isNone: false,
        isEmpty: false,
        unwrap: () => registry.createType('Raw', hexToU8a(hex)),
      };

/** A block at `number`, whose parent's state is the fake node's */
const blockAt = (
  specVersion: number,
  number: number,
  timestamp = new Date('2026-01-01T00:00:00Z')
): SubstrateBlock =>
  ({
    block: {
      header: {
        number: { toString: () => String(number), toNumber: () => number },
        parentHash: { toHex: () => '0xparent', toString: () => '0xparent' },
        hash: { toHex: () => `0xblock${number}` },
        stateRoot: { toHex: () => '0xstate' },
        extrinsicsRoot: { toHex: () => '0xextrinsics' },
      },
      extrinsics: [],
    },
    events: [],
    specVersion,
    timestamp,
  } as unknown as SubstrateBlock);

const fake = (
  specName: string,
  specVersion: number,
  metadata: Uint8Array | string,
  raw: [string, string][] = [],
  ss58Format = 42
): FakeChain => {
  const { registry, query, tx } = registryOf(specName, specVersion, metadata, ss58Format);
  const storage = new Map<string, string>(raw);
  const hexOf = (key: unknown) =>
    typeof key === 'string' ? key : (key as { toHex(): string }).toHex();
  // in the order the node returns keys
  const sortedKeys = () => [...storage.keys()].sort(byCodeUnit);
  const { store, rows } = memoryStore();

  const g = globalThis as any;
  g.store = store;
  g.api = {
    registry,
    query,
    runtimeVersion: {
      specName: { toString: () => specName },
      specVersion: { toNumber: () => specVersion },
    },
    rpc: {
      state: {
        getKeysPaged: (prefix: unknown, count: number, startKey: unknown) => {
          const from = hexOf(startKey);
          return Promise.resolve(
            sortedKeys()
              .filter(key => key.startsWith(hexOf(prefix)) && key > from)
              .slice(0, count)
              .map(key => registry.createType('StorageKey', key))
          );
        },
        queryStorageAt: (keys: unknown[]) =>
          Promise.resolve(keys.map(key => option(registry, storage.get(hexOf(key))))),
        getStorage: (key: unknown) => Promise.resolve(option(registry, storage.get(hexOf(key)))),
        getRuntimeVersion: () => Promise.resolve({ specVersion: { toNumber: () => specVersion } }),
      },
      chain: { getHeader: () => Promise.resolve({ parentHash: '0xgrandparent' }) },
    },
  };

  return {
    specVersion,
    registry,
    put(item, args, value) {
      const [section, name] = item.split('.');
      const entry = query[section]?.[name];
      if (!entry) {
        throw new Error(`spec ${specVersion} has no ${item}`);
      }
      const { type } = entry.creator.meta;
      const valueType = registry.createLookupType(type.isMap ? type.asMap.value : type.asPlain);
      // the stored SCALE bytes: a `Bytes` value's `toHex` leaves out its length prefix
      storage.set(entry.key(...args), u8aToHex(registry.createType(valueType, value).toU8a()));
    },
    call(section, method, ...args) {
      return tx[section][method](...args).toHex();
    },
    putRaw(item, args, hex) {
      const [section, name] = item.split('.');
      storage.set(query[section][name].key(...args), hex);
    },
    block: blockAt(specVersion, 1000),
    blockAt: (number, timestamp) => blockAt(specVersion, number, timestamp),
    rows,
  };
};

/** A chain on one of the runtimes whose metadata `tests/fixtures/args/metadata` records */
export const fakeChain = (specVersion: number, specName = 'polymesh_testnet'): FakeChain =>
  fake(
    specName,
    specVersion,
    gunzipSync(readFileSync(join(FIXTURES, 'args', 'metadata', `${specVersion}.bin.gz`)))
  );

/** A chain's recorded genesis (`scripts/record-genesis.ts`), its state as block 1 began */
export const genesisChain = (chain: 'testnet' | 'mainnet'): FakeChain => {
  const fixture = JSON.parse(
    gunzipSync(readFileSync(join(FIXTURES, 'genesis', `${chain}.json.gz`))).toString()
  ) as { specVersion: number; metadata: string; storage: Record<string, [string, string][]> };
  return fake(
    `polymesh_${chain}`,
    fixture.specVersion,
    fixture.metadata,
    Object.values(fixture.storage).flat(),
    chain === 'mainnet' ? 12 : 42
  );
};
