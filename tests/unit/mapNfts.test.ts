/**
 * `handleNftHoldingsUpdates` (src/mappings/entities/assets/mapNfts.ts): each token is its own `Nft`
 * row (mint = insert, transfer = one location update, burn = one column update), each holder's
 * `Holding.nftCount` and each identity's `AssetHolder.nftCount` follow it.
 */

import { handleNftHoldingsUpdates } from '../../src/mappings/entities/assets/mapNfts';
import {
  codec,
  MockDb,
  meshPortfolioHolderCodec,
  mockBulkWrites,
  mockStore,
  tupleEvent,
} from './helpers';

const ASSET = '0xcollection0000000000000000000000';
const DID_A = '0x0a'.padEnd(66, '0');
const DID_B = '0x0b'.padEnd(66, '0');

const nftEvent = (
  reason: 'issued' | 'redeemed' | 'transferred' | 'controllerTransfer',
  {
    holderDid,
    from,
    to,
    ids,
    idx = 1,
    events = [],
    method = 'NFTHoldingsUpdated',
    specVersion,
    extrinsic,
  }: {
    holderDid: string;
    from?: unknown;
    to?: unknown;
    ids: number[];
    idx?: number;
    events?: unknown[];
    method?: string;
    specVersion?: number;
    extrinsic?: unknown;
  }
) =>
  tupleEvent({
    section: 'nft',
    method,
    specVersion,
    extrinsic,
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

    expect(Object.keys(db['Nft']).sort()).toEqual([
      `${ASSET}/0000000001`,
      `${ASSET}/0000000002`,
      `${ASSET}/0000000003`,
    ]);
    expect(db['Nft'][`${ASSET}/0000000002`]).toMatchObject({
      nftId: BigInt(2),
      holdingId: `${ASSET}/${DID_A}/0`,
      createdEventId: '0000000500/0000000001',
    });
    expect(db['Nft'][`${ASSET}/0000000002`].burnedEventId).toBeUndefined();
    expect(db['Holding'][`${ASSET}/${DID_A}/0`].nftCount).toBe(3);
    expect(db['Holding'][`${ASSET}/${DID_A}/0`].assetHolderId).toBe(`${ASSET}/${DID_A}`);
    expect(db['AssetHolder'][`${ASSET}/${DID_A}`]).toMatchObject({
      nftCount: 3,
      amount: BigInt(0),
    });
  });

  it('reads the pre-v8 NFTPortfolioUpdated under the same names', async () => {
    await handleNftHoldingsUpdates(
      nftEvent('issued', {
        holderDid: DID_A,
        // before v8 a holder is always a portfolio, so the event carries the bare PortfolioId
        to: codec({ did: DID_A, kind: { default: null } }),
        ids: [4],
        method: 'NFTPortfolioUpdated',
        specVersion: 7_000_005,
      })
    );

    expect(db['Nft'][`${ASSET}/0000000004`]).toMatchObject({ holdingId: `${ASSET}/${DID_A}/0` });
  });

  it('moves the Nft row on transfer and adjusts both Holding.nftCount values', async () => {
    await handleNftHoldingsUpdates(
      nftEvent('issued', { holderDid: DID_A, to: meshPortfolioHolderCodec(DID_A, 0), ids: [7] })
    );

    await handleNftHoldingsUpdates(
      nftEvent('transferred', {
        holderDid: DID_A,
        from: meshPortfolioHolderCodec(DID_A, 0),
        to: meshPortfolioHolderCodec(DID_B, 0),
        ids: [7],
      })
    );

    expect(db['Nft'][`${ASSET}/0000000007`]).toMatchObject({
      holdingId: `${ASSET}/${DID_B}/0`,
    });
    expect(db['Holding'][`${ASSET}/${DID_A}/0`].nftCount).toBe(0);
    expect(db['Holding'][`${ASSET}/${DID_B}/0`].nftCount).toBe(1);
  });

  it('indexes a transfer that names no receiver, taking the token out of the sender only', async () => {
    await handleNftHoldingsUpdates(
      nftEvent('issued', { holderDid: DID_A, to: meshPortfolioHolderCodec(DID_A, 0), ids: [8] })
    );

    await handleNftHoldingsUpdates(
      nftEvent('transferred', {
        holderDid: DID_A,
        from: meshPortfolioHolderCodec(DID_A, 0),
        ids: [8],
      })
    );

    expect(db['Nft'][`${ASSET}/0000000008`].holdingId).toBeUndefined();
    expect(db['Holding'][`${ASSET}/${DID_A}/0`].nftCount).toBe(0);
    expect(db['AssetHolder'][`${ASSET}/${DID_A}`].nftCount).toBe(0);
  });

  it.each([
    ['controllerTransfer', 'ControllerTransfer', 'ControllerTransfer'],
    ['controllerTransferTo', 'ControllerTransferTo', 'ControllerTransferTo'],
    // the ERC-7943 precompile and batches wrap the call, so only the event names it
    ['batchAll', 'ControllerTransfer', 'ControllerTransfer'],
    ['call', 'ControllerTransferTo', 'ControllerTransferTo'],
    // before 8.1.3 neither call emitted an event of its own
    ['batchAll', undefined, 'ControllerTransfer'],
  ])(
    'labels a controller transfer by %s followed by nft.%s as %s',
    async (call, follower, expected) => {
      await handleNftHoldingsUpdates(
        nftEvent('issued', { holderDid: DID_B, to: meshPortfolioHolderCodec(DID_B, 0), ids: [5] })
      );

      await handleNftHoldingsUpdates(
        nftEvent('controllerTransfer', {
          holderDid: DID_A,
          from: meshPortfolioHolderCodec(DID_B, 0),
          to: meshPortfolioHolderCodec(DID_A, 0),
          ids: [5],
          idx: 0,
          extrinsic: { idx: 1, extrinsic: { method: { method: call } } },
          events: [
            { event: { section: 'nft', method: 'NFTHoldingsUpdated' } },
            ...(follower ? [{ event: { section: 'nft', method: follower } }] : []),
          ],
        })
      );

      const [transfer] = Object.values(db['AssetTransaction']).filter(
        (row: any) => row.fromPortfolioId
      ) as any[];
      expect(transfer).toMatchObject({ eventId: expected, fromPortfolioId: `${DID_B}/0` });
      expect(db['Nft'][`${ASSET}/0000000005`]).toMatchObject({
        holdingId: `${ASSET}/${DID_A}/0`,
      });
    }
  );

  it('labels each of two controller transfers in one batch by the event that follows it', async () => {
    await handleNftHoldingsUpdates(
      nftEvent('issued', { holderDid: DID_B, to: meshPortfolioHolderCodec(DID_B, 0), ids: [5, 6] })
    );

    const events = [
      { event: { section: 'nft', method: 'NFTHoldingsUpdated' } },
      { event: { section: 'nft', method: 'ControllerTransfer' } },
      { event: { section: 'nft', method: 'NFTHoldingsUpdated' } },
      { event: { section: 'nft', method: 'ControllerTransferTo' } },
    ];
    for (const [idx, nftId] of [
      [0, 5],
      [2, 6],
    ]) {
      await handleNftHoldingsUpdates(
        nftEvent('controllerTransfer', {
          holderDid: DID_A,
          from: meshPortfolioHolderCodec(DID_B, 0),
          to: meshPortfolioHolderCodec(DID_A, 0),
          ids: [nftId],
          idx,
          extrinsic: { idx: 1, extrinsic: { method: { method: 'batchAll' } } },
          events,
        })
      );
    }

    const labels = (Object.values(db['AssetTransaction']) as any[])
      .filter(row => row.fromPortfolioId)
      .map(row => [row.nftIds, row.eventId]);
    expect(labels).toEqual([
      [[BigInt(5)], 'ControllerTransfer'],
      [[BigInt(6)], 'ControllerTransferTo'],
    ]);
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

    await handleNftHoldingsUpdates(
      nftEvent('redeemed', { holderDid: DID_A, from: meshPortfolioHolderCodec(DID_A, 0), ids: [9] })
    );

    expect(db['Nft'][`${ASSET}/0000000009`].burnedEventId).toBeDefined();
    expect(db['Nft'][`${ASSET}/0000000009`].holdingId).toBeUndefined();
    expect(db['Holding'][`${ASSET}/${DID_A}/0`].nftCount).toBe(0);
    expect(db['Asset'][ASSET].totalSupply).toBe(BigInt(0));
  });

  it('leaves the identity rollup unchanged on a transfer between its own portfolios', async () => {
    await handleNftHoldingsUpdates(
      nftEvent('issued', { holderDid: DID_A, to: meshPortfolioHolderCodec(DID_A, 0), ids: [1, 2] })
    );

    await handleNftHoldingsUpdates(
      nftEvent('transferred', {
        holderDid: DID_A,
        from: meshPortfolioHolderCodec(DID_A, 0),
        to: meshPortfolioHolderCodec(DID_A, 1),
        ids: [1],
      })
    );

    expect(db['AssetHolder'][`${ASSET}/${DID_A}`].nftCount).toBe(2);
    expect(db['Holding'][`${ASSET}/${DID_A}/0`].nftCount).toBe(1);
    expect(db['Holding'][`${ASSET}/${DID_A}/1`].nftCount).toBe(1);
  });

  it('counts a token that leaves a holder and comes back within one block once', async () => {
    await handleNftHoldingsUpdates(
      nftEvent('issued', {
        holderDid: DID_A,
        to: meshPortfolioHolderCodec(DID_A, 0),
        ids: [1, 2, 3],
      })
    );

    // three holdings events in one block
    const events = [0, 1, 2].map(() => ({
      event: { section: 'nft', method: 'NFTHoldingsUpdated' },
    }));
    const there = {
      from: meshPortfolioHolderCodec(DID_A, 0),
      to: meshPortfolioHolderCodec(DID_B, 0),
    };
    const back = {
      from: meshPortfolioHolderCodec(DID_B, 0),
      to: meshPortfolioHolderCodec(DID_A, 0),
    };

    await handleNftHoldingsUpdates(
      nftEvent('transferred', { holderDid: DID_A, ...there, ids: [2], idx: 0, events })
    );
    await handleNftHoldingsUpdates(
      nftEvent('transferred', { holderDid: DID_B, ...back, ids: [2], idx: 1, events })
    );
    await handleNftHoldingsUpdates(
      nftEvent('redeemed', {
        holderDid: DID_A,
        from: meshPortfolioHolderCodec(DID_A, 0),
        ids: [3],
        idx: 2,
        events,
      })
    );

    expect(db['AssetHolder'][`${ASSET}/${DID_A}`].nftCount).toBe(2);
    expect(db['AssetHolder'][`${ASSET}/${DID_B}`].nftCount).toBe(0);
    expect(db['Asset'][ASSET].holderCount).toBe(1);
  });
});
