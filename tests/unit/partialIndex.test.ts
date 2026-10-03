import { SubstrateEvent } from '@subql/types';
import { getAsset } from '../../src/mappings/entities/common';
import {
  __resetIndexOrigin,
  isPartialIndex,
  writeIndexOrigin,
} from '../../src/mappings/indexOrigin';
import { IndexerAnomaly } from '../../src/types';
import { codec, mockStore, tupleEvent } from './helpers';

/**
 * An index started after genesis: the first block seeds itself, the index says what it vouches
 * for, and a handler that meets an asset created before the start builds it from chain storage
 * instead of failing the block.
 */
describe('the first datasource', () => {
  const firstDatasource = (startBlock?: string) => {
    let project: any;
    jest.isolateModules(() => {
      const previous = process.env.START_BLOCK;
      if (startBlock === undefined) delete process.env.START_BLOCK;
      else process.env.START_BLOCK = startBlock;
      // project.ts reads START_BLOCK when it loads, so each case needs its own copy of the module
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      project = require('../../project').default;
      if (previous === undefined) delete process.env.START_BLOCK;
      else process.env.START_BLOCK = previous;
    });

    return project.dataSources[0];
  };

  it('is the genesis handler over the first block, from genesis', () => {
    expect(firstDatasource()).toMatchObject({
      startBlock: 1,
      endBlock: 1,
      mapping: { handlers: [{ handler: 'handleGenesis' }] },
    });
  });

  /** A `[1, 1]` range beside `[startBlock, ∞)` is two disjoint ranges the node never bridges. */
  it('is the seeder over the start block itself, from a later block, with no genesis range left', () => {
    expect(firstDatasource('500')).toMatchObject({
      startBlock: 500,
      endBlock: 500,
      mapping: { handlers: [{ handler: 'handleSeed' }] },
    });
  });
});

describe('IndexOrigin', () => {
  const block = (height: number) =>
    ({
      block: {
        header: { number: { toString: () => String(height) }, hash: { toHex: () => '0xabc' } },
      },
      specVersion: 8_001_020,
      timestamp: new Date('2026-01-01T00:00:00Z'),
    } as never);

  beforeEach(() => __resetIndexOrigin());

  it('vouches for every domain from genesis', async () => {
    const db = mockStore();

    await writeIndexOrigin(block(1), false);

    expect(db.IndexOrigin.origin.unseededDomains).toEqual([]);
    expect(db.IndexOrigin.origin.seededDomains).toContain('assets');
    await expect(isPartialIndex()).resolves.toBe(false);
  });

  it('lists what a later start could not seed, each with its reason', async () => {
    const db = mockStore();

    await writeIndexOrigin(block(500), true);

    expect(db.IndexOrigin.origin).toMatchObject({ startBlock: 500, startBlockHash: '0xabc' });
    expect(db.IndexOrigin.origin.seededDomains).toEqual([
      'polyxBalances',
      'portfolioHoldings',
      'multiSigs',
      'evmAccountMappings',
    ]);
    expect(db.IndexOrigin.origin.unseededDomains).toEqual(
      expect.arrayContaining([expect.stringMatching(/^assetCounts: .*relative/)])
    );
    await expect(isPartialIndex()).resolves.toBe(true);
  });
});

describe('an asset the index has never seen', () => {
  const ASSET = '0x0123456789abcdef0123456789abcdef';
  const OWNER = '0x' + '11'.repeat(32);

  const event = () =>
    tupleEvent({
      section: 'asset',
      method: 'Issued',
      data: [codec(OWNER)],
      specVersion: 8_001_020,
    }) as SubstrateEvent;

  const chainHas = (asset: boolean) => {
    (globalThis as any).api.query = {
      asset: {
        assets: jest.fn().mockResolvedValue(
          asset
            ? {
                isNone: false,
                unwrap: () => ({
                  totalSupply: codec('5000'),
                  ownerDid: codec(OWNER),
                  divisible: codec(true),
                  assetType: {
                    ...codec({ equityCommon: null }),
                    isNonFungible: false,
                    type: 'EquityCommon',
                  },
                }),
              }
            : { isNone: true }
        ),
        assetNames: jest.fn().mockResolvedValue(codec('0x4d7920417373657400')),
        fundingRound: jest.fn().mockResolvedValue(codec('')),
        assetIdentifiers: jest.fn().mockResolvedValue(codec([])),
        frozen: jest.fn().mockResolvedValue(codec(false)),
        assetIdTicker: jest.fn().mockResolvedValue({ isSome: false }),
      },
      complianceManager: {
        assetCompliances: jest.fn().mockResolvedValue(codec({ paused: false })),
      },
      identity: {
        didRecords: jest
          .fn()
          .mockResolvedValue({ isEmpty: false, toJSON: () => ({ primaryKey: '5Owner' }) }),
      },
    };
  };

  beforeEach(() => __resetIndexOrigin());

  it('is built from chain storage, carrying the real supply rather than starting at zero', async () => {
    const db = mockStore({ IndexOrigin: { origin: { id: 'origin', startBlock: 500 } } });
    chainHas(true);

    const asset = await getAsset(ASSET, event());

    expect(asset).toMatchObject({
      totalSupply: BigInt(5000),
      ownerId: OWNER,
      isDivisible: true,
      holderCount: 0,
    });
    expect(db.Identity[OWNER]).toBeDefined();
  });

  it('is expected on a partial index, but a gap on a genesis replay — and recorded as one', async () => {
    mockStore({ IndexOrigin: { origin: { id: 'origin', startBlock: 1 } } });
    chainHas(true);
    const anomaly = jest.spyOn(IndexerAnomaly.prototype, 'save').mockResolvedValue(undefined);

    await getAsset(ASSET, event());

    expect(anomaly).toHaveBeenCalledTimes(1);
  });

  it('still fails when the chain does not know the asset either', async () => {
    mockStore();
    chainHas(false);
    jest.spyOn(IndexerAnomaly.prototype, 'save').mockResolvedValue(undefined);

    await expect(getAsset(ASSET, event())).rejects.toThrow(/was not found/);
  });
});
