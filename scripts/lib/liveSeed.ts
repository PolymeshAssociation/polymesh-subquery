/**
 * Runs the seed against a live node into memory, as the indexer would at `height`: the seeders read
 * the state `height` began from through the same snapshot, and their rows land in a memory store.
 */
import '@polkadot/types-augment';
import '@polymeshassociation/polymesh-types/polkadot/types-lookup';
import '@polymeshassociation/polymesh-types/polkadot/augment-api';
import { ApiPromise, WsProvider } from '@polkadot/api';
import chainTypes from '../../src/chainTypes';
import { memoryStore } from './memoryStore';

type Row = Record<string, unknown>;

export interface LiveSeed {
  specVersion: number;
  ms: number;
  rows: Record<string, Row[]>;
  /** RPC calls made, by method */
  requests: Record<string, number>;
}

export const connect = (endpoint: string): Promise<ApiPromise> =>
  ApiPromise.create({
    provider: new WsProvider(endpoint),
    noInitWarn: true,
    types: chainTypes.types as never,
    typesBundle: chainTypes.typesBundle as never,
  });

/** Seeds what `entities` names (every seeder when omitted) at `height` into memory */
export const seedLive = async (
  api: ApiPromise,
  height: number,
  entities?: string[]
): Promise<LiveSeed> => {
  const parentHash = (await api.rpc.chain.getBlockHash(height - 1)).toHex();
  const hash = (await api.rpc.chain.getBlockHash(height)).toHex();
  const at = await api.at(parentHash);
  const requests: Record<string, number> = {};
  const counted = <T extends object>(target: T, section: string): T =>
    new Proxy(target, {
      get: (methods, method: string) => {
        const call = (methods as Record<string, (...args: unknown[]) => unknown>)[method];
        return (...args: unknown[]) => {
          requests[`${section}.${method}`] = (requests[`${section}.${method}`] ?? 0) + 1;
          return call(...args);
        };
      },
    });
  const rpc = new Proxy(api.rpc, {
    get: (sections, section: string) =>
      counted((sections as unknown as Record<string, object>)[section], section),
  });

  const { db, store } = memoryStore();
  Object.assign(globalThis, {
    api: {
      query: at.query,
      registry: at.registry,
      rpc,
      runtimeVersion: at.runtimeVersion,
      genesisHash: api.genesisHash,
    },
    chainId: api.genesisHash.toHex(),
    store,
    logger: {
      info: () => undefined,
      warn: (message: string) => console.warn(message),
      debug: () => undefined,
      error: console.error,
    },
  });

  // loaded once the globals the mappings read at import are in place
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { seed } = require('../../src/seed/seeder');
  const { SEEDERS } = require('../../src/seed/seeders');
  const { accountRows } = require('../../src/seed/seeders/identities');
  const { snapshotAtParent } = require('../../src/seed/snapshot');
  /* eslint-enable @typescript-eslint/no-var-requires */

  const specVersion = at.runtimeVersion.specVersion.toNumber();
  const block = {
    block: {
      header: {
        number: { toString: () => String(height) },
        parentHash,
        hash: { toHex: () => hash },
      },
    },
    specVersion,
    timestamp: new Date(0),
  };
  const seeders = entities
    ? SEEDERS.filter(({ entity }: { entity: string }) => entities.includes(entity))
    : SEEDERS;
  const started = Date.now();
  await seed(
    snapshotAtParent(block as never),
    {
      block,
      blockId: String(height).padStart(10, '0'),
      eventId: `${String(height).padStart(10, '0')}/seed`,
      datetime: new Date(0),
      specVersion,
    },
    { seeders, accountRows }
  );

  return {
    specVersion,
    ms: Date.now() - started,
    rows: Object.fromEntries(
      Object.entries(db).map(([entity, table]) => [entity, [...table.values()]])
    ),
    requests,
  };
};
