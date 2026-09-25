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
import {
  codec,
  MockDb,
  meshPortfolioHolderCodec,
  mockBulkWrites,
  mockStore,
  storeSet,
  tupleEvent,
} from './helpers';

const ASSET = '0xcollection0000000000000000000000';
const DID_A = '0x0a'.padEnd(66, '0');
const DID_B = '0x0b'.padEnd(66, '0');

const nftEvent = (
  reason: 'issued' | 'redeemed' | 'transferred',
  {
    holderDid,
    from,
    to,
    ids,
    idx = 1,
    events = [],
  }: {
    holderDid: string;
    from?: unknown;
    to?: unknown;
    ids: number[];
    idx?: number;
    events?: unknown[];
  }
) =>
  tupleEvent({
    section: 'nft',
    method: 'NFTHoldingsUpdated',
    idx,
    events,
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
          holderCount: 0,
          isNftCollection: true,
        },
      },
    });
    mockBulkWrites(db, 'Nft');
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

  it('counts identities holding the collection in Asset.holderCount', async () => {
    const holderCount = () => db['Asset'][ASSET].holderCount;

    await handleNftHoldingsUpdates(
      nftEvent('issued', { holderDid: DID_A, to: meshPortfolioHolderCodec(DID_A, 0), ids: [1, 2] })
    );
    expect(holderCount()).toBe(1);

    // one of two tokens to B: A still holds one, B starts holding
    await handleNftHoldingsUpdates(
      nftEvent('transferred', {
        holderDid: DID_A,
        from: meshPortfolioHolderCodec(DID_A, 0),
        to: meshPortfolioHolderCodec(DID_B, 0),
        ids: [1],
      })
    );
    expect(holderCount()).toBe(2);

    // between A's own portfolios: no identity starts or stops holding
    await handleNftHoldingsUpdates(
      nftEvent('transferred', {
        holderDid: DID_A,
        from: meshPortfolioHolderCodec(DID_A, 0),
        to: meshPortfolioHolderCodec(DID_A, 1),
        ids: [2],
      })
    );
    expect(holderCount()).toBe(2);

    await handleNftHoldingsUpdates(
      nftEvent('redeemed', { holderDid: DID_B, from: meshPortfolioHolderCodec(DID_B, 0), ids: [1] })
    );
    expect(holderCount()).toBe(1);
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

  it('writes a newly-first-seen NftHolder once, not twice', async () => {
    await handleNftHoldingsUpdates(
      nftEvent('issued', { holderDid: DID_A, to: meshPortfolioHolderCodec(DID_A, 0), ids: [11] })
    );
    await flushNftBuffer();

    const nftHolderSaves = storeSet().mock.calls.filter(([entity]) => entity === 'NftHolder');
    expect(nftHolderSaves).toHaveLength(1);
    expect(db['NftHolder'][`${ASSET}/${DID_A}`].nftIds).toEqual([BigInt(11)]);
  });

  it('does not duplicate or drop ids on a same-block, same-identity, cross-portfolio transfer', async () => {
    // Mint in an earlier block so the rollup is already saved (not buffered) when the
    // same-identity transfer below runs — that's the condition that exposed the aliasing bug:
    // two independent `getNftHolder` calls for the same not-yet-buffered holder id.
    await handleNftHoldingsUpdates(
      nftEvent('issued', { holderDid: DID_A, to: meshPortfolioHolderCodec(DID_A, 0), ids: [1, 2] })
    );
    await flushNftBuffer();

    await handleNftHoldingsUpdates(
      nftEvent('transferred', {
        holderDid: DID_A,
        from: meshPortfolioHolderCodec(DID_A, 0),
        to: meshPortfolioHolderCodec(DID_A, 1),
        ids: [1],
      })
    );
    await flushNftBuffer();

    const { nftIds } = db['NftHolder'][`${ASSET}/${DID_A}`];
    expect(nftIds.filter((id: bigint) => id === BigInt(1))).toHaveLength(1);
    expect(nftIds.filter((id: bigint) => id === BigInt(2))).toHaveLength(1);
    expect(nftIds).toHaveLength(2);
  });
});

/**
 * The holder rollup is buffered across a block's holdings events and written by the last of them.
 * Writing it from a later block instead would date the change to that block, since a row's
 * validity begins where it is saved — and having a block handler do it means subscribing to every
 * block, which is what costs the dictionary its ability to skip empty heights.
 */
describe('handleNftHoldingsUpdates — when the holder rollup is written', () => {
  let db: MockDb;

  /** A block whose event list holds two holdings events, at indexes 0 and 1. */
  const blockEvents = [
    { event: { section: 'nft', method: 'NFTHoldingsUpdated' } },
    { event: { section: 'nft', method: 'NFTHoldingsUpdated' } },
  ];

  beforeEach(() => {
    __resetNftBuffer();
    db = mockStore({
      Asset: {
        [ASSET]: {
          id: ASSET,
          totalSupply: BigInt(0),
          totalTransfers: BigInt(0),
          holderCount: 0,
          isNftCollection: true,
        },
      },
    });
    mockBulkWrites(db, 'Nft');
  });

  const holderSaves = () =>
    storeSet().mock.calls.filter(([entity]) => entity === 'NftHolder').length;

  it('holds the write back while a later holdings event is still to come', async () => {
    await handleNftHoldingsUpdates(
      nftEvent('issued', {
        holderDid: DID_A,
        to: meshPortfolioHolderCodec(DID_A, 0),
        ids: [1],
        idx: 0,
        events: blockEvents,
      })
    );

    expect(holderSaves()).toBe(0);
  });

  it('writes each holder once, from the last holdings event of the block', async () => {
    for (const [idx, ids] of [
      [0, [1]],
      [1, [2]],
    ] as [number, number[]][]) {
      await handleNftHoldingsUpdates(
        nftEvent('issued', {
          holderDid: DID_A,
          to: meshPortfolioHolderCodec(DID_A, 0),
          ids,
          idx,
          events: blockEvents,
        })
      );
    }

    expect(holderSaves()).toBe(1);
    expect(db['NftHolder'][`${ASSET}/${DID_A}`].nftIds).toEqual([BigInt(1), BigInt(2)]);
  });

  it('writes it without any outside flush when it is the only holdings event', async () => {
    await handleNftHoldingsUpdates(
      nftEvent('issued', {
        holderDid: DID_A,
        to: meshPortfolioHolderCodec(DID_A, 0),
        ids: [3],
        idx: 0,
        events: [blockEvents[0]],
      })
    );

    expect(holderSaves()).toBe(1);
    expect(db['NftHolder'][`${ASSET}/${DID_A}`].nftIds).toEqual([BigInt(3)]);
  });
});
