/**
 * `handleNftHoldingsUpdates` (src/mappings/entities/assets/mapNfts.ts) after the G9/G10 rewrite:
 * each token id is now its own `Nft` row (mint = insert, transfer = one location update, burn =
 * one column update) instead of being pushed onto / filtered out of `NftHolder.nftIds`. The
 * `NftHolder` rollup is still written, per the SDK. `Holding.nftCount` tracks each side.
 */

import { SubstrateEvent } from '@subql/types';
import {
  __resetNftBuffer,
  flushNftBuffer,
  handleNftHoldingsUpdates,
} from '../../src/mappings/entities/assets/mapNfts';

const ASSET = '0xcollection0000000000000000000000';
const DID_A = '0x0a'.padEnd(66, '0');
const DID_B = '0x0b'.padEnd(66, '0');

const storeGet = (): jest.Mock => (globalThis as any).store.get as jest.Mock;
const storeSet = (): jest.Mock => (globalThis as any).store.set as jest.Mock;

const codec = (value: unknown) => ({
  isEmpty: value === undefined || value === null,
  toString: () => (typeof value === 'string' ? value : JSON.stringify(value)),
  toJSON: () => value,
});

const portfolioHolderCodec = (did: string, number = 0) =>
  codec({ portfolio: { did, kind: number ? { user: number } : { default: null } } });

const nftEvent = (
  reason: 'issued' | 'redeemed' | 'transferred',
  { holderDid, from, to, ids }: { holderDid: string; from?: unknown; to?: unknown; ids: number[] }
): SubstrateEvent =>
  ({
    idx: 1,
    extrinsic: undefined,
    block: {
      block: { header: { number: { toString: () => '500' } } },
      timestamp: new Date('2026-02-01T00:00:00Z'),
      specVersion: 8000000,
      events: [],
    },
    event: {
      method: 'NFTHoldingsUpdated',
      section: 'nft',
      data: [
        codec(holderDid),
        codec({ assetId: ASSET, ids }),
        from ?? codec(undefined),
        to ?? codec(undefined),
        codec(
          reason === 'transferred'
            ? { transferred: { instructionId: '7', instructionMemo: null } }
            : { [reason]: null }
        ),
      ],
    },
  } as unknown as SubstrateEvent);

describe('handleNftHoldingsUpdates — per-token Nft rows', () => {
  let db: Record<string, Record<string, any>>;

  beforeEach(() => {
    __resetNftBuffer();
    db = {};
    db['Asset'] = {
      [ASSET]: {
        id: ASSET,
        totalSupply: BigInt(0),
        totalTransfers: BigInt(0),
        isNftCollection: true,
      },
    };
    storeGet().mockImplementation((entity: string, id: string) =>
      Promise.resolve(db[entity]?.[id])
    );
    storeSet().mockImplementation((entity: string, id: string, data: any) => {
      (db[entity] ??= {})[id] = { ...data };
      return Promise.resolve();
    });
    (globalThis as any).api.query = {};
  });

  it('mints one Nft row per issued token and raises Holding.nftCount', async () => {
    await handleNftHoldingsUpdates(
      nftEvent('issued', { holderDid: DID_A, to: portfolioHolderCodec(DID_A, 0), ids: [1, 2, 3] })
    );
    await flushNftBuffer();

    expect(Object.keys(db['Nft']).sort()).toEqual([
      `${ASSET}/0000000001`,
      `${ASSET}/0000000002`,
      `${ASSET}/0000000003`,
    ]);
    expect(db['Nft'][`${ASSET}/0000000002`]).toMatchObject({
      nftId: BigInt(2),
      portfolioId: `${DID_A}/0`,
      identityId: DID_A,
      mintedBlockId: '0000000500',
    });
    expect(db['Nft'][`${ASSET}/0000000002`].burnedBlockId).toBeUndefined();
    expect(db['Holding'][`${ASSET}/${DID_A}/0`].nftCount).toBe(3);
    // rollup still maintained
    expect(db['NftHolder'][`${ASSET}/${DID_A}`].nftIds).toEqual([1, 2, 3]);
  });

  it('moves the Nft row on transfer and adjusts both Holding.nftCount values', async () => {
    await handleNftHoldingsUpdates(
      nftEvent('issued', { holderDid: DID_A, to: portfolioHolderCodec(DID_A, 0), ids: [7] })
    );
    await flushNftBuffer();

    await handleNftHoldingsUpdates(
      nftEvent('transferred', {
        holderDid: DID_A,
        from: portfolioHolderCodec(DID_A, 0),
        to: portfolioHolderCodec(DID_B, 0),
        ids: [7],
      })
    );
    await flushNftBuffer();

    expect(db['Nft'][`${ASSET}/0000000007`]).toMatchObject({
      portfolioId: `${DID_B}/0`,
      identityId: DID_B,
    });
    expect(db['Holding'][`${ASSET}/${DID_A}/0`].nftCount).toBe(0);
    expect(db['Holding'][`${ASSET}/${DID_B}/0`].nftCount).toBe(1);
  });

  it('marks the Nft burned on redemption but leaves the row queryable', async () => {
    await handleNftHoldingsUpdates(
      nftEvent('issued', { holderDid: DID_A, to: portfolioHolderCodec(DID_A, 0), ids: [9] })
    );
    await flushNftBuffer();

    await handleNftHoldingsUpdates(
      nftEvent('redeemed', { holderDid: DID_A, from: portfolioHolderCodec(DID_A, 0), ids: [9] })
    );
    await flushNftBuffer();

    expect(db['Nft'][`${ASSET}/0000000009`].burnedBlockId).toBe('0000000500');
    expect(db['Holding'][`${ASSET}/${DID_A}/0`].nftCount).toBe(0);
    expect(db['Asset'][ASSET].totalSupply).toBe(BigInt(0));
  });
});
