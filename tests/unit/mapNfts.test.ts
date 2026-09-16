/**
 * `handleNftHoldingsUpdates` (src/mappings/entities/assets/mapNfts.ts) after the G9/G10 rewrite:
 * each token id is now its own `Nft` row (mint = insert, transfer = one location update, burn =
 * one column update) instead of being pushed onto / filtered out of `NftHolder.nftIds`. The
 * `NftHolder` rollup is still written, per the SDK. `Holding.nftCount` tracks each side.
 */

import {
  __resetNftBuffer,
  flushNftBuffer,
  handleNftHoldingsUpdates,
} from '../../src/mappings/entities/assets/mapNfts';
import { codec, MockDb, meshPortfolioHolderCodec, mockStore, tupleEvent } from './helpers';

const ASSET = '0xcollection0000000000000000000000';
const DID_A = '0x0a'.padEnd(66, '0');
const DID_B = '0x0b'.padEnd(66, '0');

const nftEvent = (
  reason: 'issued' | 'redeemed' | 'transferred',
  { holderDid, from, to, ids }: { holderDid: string; from?: unknown; to?: unknown; ids: number[] }
) =>
  tupleEvent({
    section: 'nft',
    method: 'NFTHoldingsUpdated',
    idx: 1,
    blockNumber: '500',
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
  });

describe('handleNftHoldingsUpdates — per-token Nft rows', () => {
  let db: MockDb;

  beforeEach(() => {
    __resetNftBuffer();
    db = mockStore({
      Asset: {
        [ASSET]: {
          id: ASSET,
          totalSupply: BigInt(0),
          totalTransfers: BigInt(0),
          isNftCollection: true,
        },
      },
    });
  });

  it('mints one Nft row per issued token and raises Holding.nftCount', async () => {
    await handleNftHoldingsUpdates(
      nftEvent('issued', {
        holderDid: DID_A,
        to: meshPortfolioHolderCodec(DID_A, 0),
        ids: [1, 2, 3],
      })
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
      createdEventId: '0000000500/0000000001',
    });
    expect(db['Nft'][`${ASSET}/0000000002`].burnedEventId).toBeUndefined();
    expect(db['Holding'][`${ASSET}/${DID_A}/0`].nftCount).toBe(3);
    // rollup still maintained
    expect(db['NftHolder'][`${ASSET}/${DID_A}`].nftIds).toEqual([BigInt(1), BigInt(2), BigInt(3)]);
  });

  it('moves the Nft row on transfer and adjusts both Holding.nftCount values', async () => {
    await handleNftHoldingsUpdates(
      nftEvent('issued', { holderDid: DID_A, to: meshPortfolioHolderCodec(DID_A, 0), ids: [7] })
    );
    await flushNftBuffer();

    await handleNftHoldingsUpdates(
      nftEvent('transferred', {
        holderDid: DID_A,
        from: meshPortfolioHolderCodec(DID_A, 0),
        to: meshPortfolioHolderCodec(DID_B, 0),
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
      nftEvent('issued', { holderDid: DID_A, to: meshPortfolioHolderCodec(DID_A, 0), ids: [9] })
    );
    await flushNftBuffer();

    await handleNftHoldingsUpdates(
      nftEvent('redeemed', { holderDid: DID_A, from: meshPortfolioHolderCodec(DID_A, 0), ids: [9] })
    );
    await flushNftBuffer();

    expect(db['Nft'][`${ASSET}/0000000009`].burnedEventId).toBeDefined();
    expect(db['Holding'][`${ASSET}/${DID_A}/0`].nftCount).toBe(0);
    expect(db['Asset'][ASSET].totalSupply).toBe(BigInt(0));
  });
});
