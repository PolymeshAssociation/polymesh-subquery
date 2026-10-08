/**
 * `applyHoldingDelta` (src/mappings/entities/assets/mapAsset.ts) — the shared writer that keeps
 * the portfolio/account-grain `Holding` row and the identity-grain `AssetHolder` rollup in step,
 * and moves `Asset.holderCount` as the rollup crosses zero.
 */

import {
  applyHoldingDelta,
  handleAssetTransfer,
  handleIssued,
  handleRedeemed,
} from '../../src/mappings/entities/assets/mapAsset';
import { handleFundsMovedBetweenPortfolios } from '../../src/mappings/entities/identities/mapPortfolio';
import { handleFundsTransferred } from '../../src/mappings/entities/settlements/mapSettlement';
import { accountHolder, emptyDid, padId, portfolioHolder } from '../../src/utils';
import { codec, MockDb, mockStore, tupleEvent } from './helpers';

const ASSET = '0xaaaa';
const DID = '0x01'.padEnd(66, '0');
const BLOCK = '0000000100';

const storeGet = (): jest.Mock => (globalThis as any).store.get as jest.Mock;
const storeSet = (): jest.Mock => (globalThis as any).store.set as jest.Mock;

type Row = Record<string, any>;

const makeAsset = (holderCount = 0): Row => ({ id: ASSET, holderCount });

const flush = async (fn: (promises: Promise<void>[]) => Promise<void>): Promise<void> => {
  const promises: Promise<void>[] = [];
  await fn(promises);
  await Promise.all(promises);
};

describe('applyHoldingDelta', () => {
  let db: Record<string, Record<string, Row>>;

  beforeEach(() => {
    db = {};
    storeGet().mockImplementation((entity: string, id: string) =>
      Promise.resolve(db[entity]?.[id])
    );
    storeSet().mockImplementation((entity: string, id: string, data: Row) => {
      (db[entity] ??= {})[id] = { ...data };
      return Promise.resolve();
    });
  });

  it('an issuance creates the Holding, the rollup, and increments holderCount', async () => {
    const asset = makeAsset(0);

    await flush(p =>
      applyHoldingDelta(asset as any, portfolioHolder(DID, 0), BLOCK, BigInt(1000), p)
    );

    expect(db['Holding'][`${ASSET}/${DID}/0`]).toMatchObject({
      amount: BigInt(1000),
      holderKind: 'Portfolio',
      portfolioId: `${DID}/0`,
      identityId: DID,
      nftCount: 0,
    });
    expect(db['AssetHolder'][`${ASSET}/${DID}`].amount).toBe(BigInt(1000));
    expect(asset.holderCount).toBe(1);
  });

  it('a portfolio-to-portfolio transfer within one identity moves two Holding rows and leaves the rollup net-zero', async () => {
    const asset = makeAsset(1);
    db['AssetHolder'] = {
      [`${ASSET}/${DID}`]: {
        id: `${ASSET}/${DID}`,
        assetId: ASSET,
        identityId: DID,
        amount: BigInt(1000),
      },
    };
    db['Holding'] = {
      [`${ASSET}/${DID}/0`]: {
        id: `${ASSET}/${DID}/0`,
        assetId: ASSET,
        holderKind: 'Portfolio',
        portfolioId: `${DID}/0`,
        identityId: DID,
        amount: BigInt(1000),
        nftCount: 0,
      },
    };

    await flush(async p => {
      await applyHoldingDelta(asset as any, portfolioHolder(DID, 0), BLOCK, BigInt(-400), p);
      await applyHoldingDelta(asset as any, portfolioHolder(DID, 1), BLOCK, BigInt(400), p);
    });

    expect(db['Holding'][`${ASSET}/${DID}/0`].amount).toBe(BigInt(600));
    expect(db['Holding'][`${ASSET}/${DID}/1`].amount).toBe(BigInt(400));
    // identity net zero — the case the old identity-grain model could not express
    expect(db['AssetHolder'][`${ASSET}/${DID}`].amount).toBe(BigInt(1000));
    expect(asset.holderCount).toBe(1);
  });

  it('an account holder with no known Identity gets a Holding row but no rollup', async () => {
    const asset = makeAsset(0);

    await flush(p =>
      applyHoldingDelta(
        asset as any,
        accountHolder(undefined, '5FHneW46xGiveU'),
        BLOCK,
        BigInt(50),
        p
      )
    );

    expect(db['Holding'][`${ASSET}/5FHneW46xGiveU`]).toMatchObject({
      amount: BigInt(50),
      holderKind: 'Account',
      accountId: '5FHneW46xGiveU',
    });
    expect(db['Holding'][`${ASSET}/5FHneW46xGiveU`].identityId).toBeUndefined();
    expect(db['AssetHolder']).toBeUndefined();
    expect(asset.holderCount).toBe(0);
  });

  it('a redemption that empties the rollup decrements holderCount', async () => {
    const asset = makeAsset(1);
    db['AssetHolder'] = {
      [`${ASSET}/${DID}`]: {
        id: `${ASSET}/${DID}`,
        assetId: ASSET,
        identityId: DID,
        amount: BigInt(500),
      },
    };
    db['Holding'] = {
      [`${ASSET}/${DID}/0`]: {
        id: `${ASSET}/${DID}/0`,
        assetId: ASSET,
        holderKind: 'Portfolio',
        portfolioId: `${DID}/0`,
        identityId: DID,
        amount: BigInt(500),
        nftCount: 0,
      },
    };

    await flush(p =>
      applyHoldingDelta(asset as any, portfolioHolder(DID, 0), BLOCK, BigInt(-500), p)
    );

    expect(db['Holding'][`${ASSET}/${DID}/0`].amount).toBe(BigInt(0));
    expect(db['AssetHolder'][`${ASSET}/${DID}`].amount).toBe(BigInt(0));
    expect(asset.holderCount).toBe(0);
  });

  it('restamps the identity when an account that re-linked receives the asset again', async () => {
    const OTHER = '0x02'.padEnd(66, '0');
    const asset = makeAsset(0);
    const account = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

    await flush(p =>
      applyHoldingDelta(asset as any, accountHolder(DID, account), BLOCK, BigInt(5), p)
    );
    await flush(p =>
      applyHoldingDelta(asset as any, accountHolder(DID, account), BLOCK, BigInt(-5), p)
    );
    // the key leaves DID and joins OTHER, then receives the asset again
    await flush(p =>
      applyHoldingDelta(asset as any, accountHolder(OTHER, account), BLOCK, BigInt(3), p)
    );

    expect(db['Holding'][`${ASSET}/${account}`]).toMatchObject({
      identityId: OTHER,
      amount: BigInt(3),
    });
    expect(db['AssetHolder'][`${ASSET}/${OTHER}`].amount).toBe(BigInt(3));
  });
});

/**
 * Holdings from the events that carried no balance update of their own: pre-v6 issuance, transfers
 * and redemptions, and portfolio moves. None wrote `Holding`, so a testnet resync found 4,537
 * non-zero chain portfolio balances with no row, and portfolio moves left both sides wrong.
 */
describe('Holding from pre-v6 events and portfolio moves', () => {
  const ASSET_ID = `0x${'a3'.repeat(16)}`;
  const OTHER = '0x02'.padEnd(66, '0');
  const portfolio = (did: string, number: number) =>
    codec(number === 0 ? { did, kind: { default: null } } : { did, kind: { user: number } });
  const pre6 = { specVersion: 5_004_000 };
  let db: MockDb;

  beforeEach(() => {
    db = mockStore({
      Asset: {
        [ASSET_ID]: {
          id: ASSET_ID,
          totalSupply: BigInt(0),
          totalTransfers: BigInt(0),
          holderCount: 0,
        },
      },
    });
  });

  const holding = (did: string, number: number) => db.Holding?.[`${ASSET_ID}/${did}/${number}`];
  // a pre-v6 controller transfer: `asset.Transfer`, then `asset.ControllerTransfer`, so no instruction
  const record = (method: string) => ({
    phase: { toString: () => 'ApplyExtrinsic(1)' },
    event: { section: 'asset', method },
  });
  const controllerTransfer = [record('Issued'), record('Transfer'), record('ControllerTransfer')];

  it("credits a pre-v6 issuance to the beneficiary's default portfolio", async () => {
    await handleIssued(
      tupleEvent({
        section: 'asset',
        method: 'Issued',
        data: [codec(DID), codec(ASSET_ID), codec(DID), codec('1000'), codec(''), codec('0')],
        ...pre6,
      })
    );

    expect(holding(DID, 0)).toMatchObject({ amount: BigInt(1000), identityId: DID });
    expect(db.AssetHolder[`${ASSET_ID}/${DID}`].amount).toBe(BigInt(1000));
    expect(db.Asset[ASSET_ID]).toMatchObject({ totalSupply: BigInt(1000), holderCount: 1 });
  });

  it('moves a pre-v6 transfer between the portfolios it names, and a redemption out of its own', async () => {
    db.Holding = {};
    await handleIssued(
      tupleEvent({
        section: 'asset',
        method: 'Issued',
        data: [codec(DID), codec(ASSET_ID), codec(DID), codec('1000'), codec(''), codec('0')],
        ...pre6,
      })
    );

    await handleAssetTransfer(
      tupleEvent({
        section: 'asset',
        method: 'Transfer',
        data: [codec(DID), codec(ASSET_ID), portfolio(DID, 0), portfolio(OTHER, 2), codec('300')],
        ...pre6,
        idx: 1,
        events: controllerTransfer,
      })
    );
    // a redemption: Transfer from the portfolio to no one, then Redeemed
    await handleAssetTransfer(
      tupleEvent({
        section: 'asset',
        method: 'Transfer',
        data: [
          codec(OTHER),
          codec(ASSET_ID),
          portfolio(OTHER, 2),
          portfolio(emptyDid, 0),
          codec('100'),
        ],
        ...pre6,
        idx: 2,
      })
    );
    await handleRedeemed(
      tupleEvent({
        section: 'asset',
        method: 'Redeemed',
        data: [codec(OTHER), codec(ASSET_ID), codec(OTHER), codec('100')],
        ...pre6,
        idx: 3,
      })
    );

    expect(holding(DID, 0).amount).toBe(BigInt(700));
    expect(holding(OTHER, 2).amount).toBe(BigInt(200));
    expect(db.AssetHolder[`${ASSET_ID}/${OTHER}`].amount).toBe(BigInt(200));
    expect(db.Asset[ASSET_ID]).toMatchObject({ totalSupply: BigInt(900), holderCount: 2 });
  });

  it('moves fungible funds between two portfolios, leaving the identity total alone', async () => {
    db.Holding = {
      [`${ASSET_ID}/${DID}/0`]: {
        id: `${ASSET_ID}/${DID}/0`,
        assetId: ASSET_ID,
        amount: BigInt(1000),
        nftCount: 0,
      },
    };

    await handleFundsMovedBetweenPortfolios(
      tupleEvent({
        section: 'portfolio',
        method: 'FundsMovedBetweenPortfolios',
        data: [
          codec(DID),
          portfolio(DID, 0),
          portfolio(DID, 1),
          codec({ fungible: { assetId: ASSET_ID, amount: 400 } }),
          codec(null),
        ],
      })
    );

    expect(holding(DID, 0).amount).toBe(BigInt(600));
    expect(holding(DID, 1).amount).toBe(BigInt(400));
    expect(db.AssetHolder?.[`${ASSET_ID}/${DID}`]).toBeUndefined();
  });

  /** Testnet: 9,997 NFTs minted to portfolio 0 and moved to portfolio 1 at 13,619,117. */
  it("moves NFTs between two portfolios, with each token's row", async () => {
    db.Holding = {
      [`${ASSET_ID}/${DID}/0`]: {
        id: `${ASSET_ID}/${DID}/0`,
        assetId: ASSET_ID,
        amount: BigInt(0),
        nftCount: 2,
      },
    };
    db.Nft = {
      [`${ASSET_ID}/${padId('1')}`]: { id: `${ASSET_ID}/${padId('1')}`, portfolioId: `${DID}/0` },
      [`${ASSET_ID}/${padId('2')}`]: { id: `${ASSET_ID}/${padId('2')}`, portfolioId: `${DID}/0` },
    };
    (globalThis as any).store.bulkUpdate = jest.fn((entity: string, rows: any[]) => {
      rows.forEach(row => (db[entity][row.id] = { ...row }));
      return Promise.resolve();
    });

    await handleFundsMovedBetweenPortfolios(
      tupleEvent({
        section: 'portfolio',
        method: 'FundsMovedBetweenPortfolios',
        data: [
          codec(DID),
          portfolio(DID, 0),
          portfolio(DID, 1),
          codec({ nonFungible: { assetId: ASSET_ID, ids: [1, 2] } }),
          codec(null),
        ],
      })
    );

    expect(holding(DID, 0).nftCount).toBe(0);
    expect(holding(DID, 1).nftCount).toBe(2);
    expect(db.Nft[`${ASSET_ID}/${padId('2')}`].portfolioId).toBe(`${DID}/1`);
  });

  /**
   * Testnet block 25,888,147: `asset.transferAsset` of 1 unit between two accounts of one identity
   * emits `settlement.FundsTransferred` and no balance event.
   */
  it('moves a v8 transfer within one identity between the holders it names', async () => {
    const FROM = '5EvJiDAzd4AiwUhAFLQ6DTfBxYjhVNWKxLqrT2XHB9RiWuqn';
    const TO = '5E2cWPmkRZD9Ph4AV2yzLK4JYmYWDkZhpqGNYxkvh1BcpCD2';
    const account = (address: string) => codec({ account: address });
    db.Holding = {
      [`${ASSET_ID}/${FROM}`]: {
        id: `${ASSET_ID}/${FROM}`,
        assetId: ASSET_ID,
        amount: BigInt(10),
        nftCount: 0,
      },
    };
    db.Account = {
      [FROM]: { id: FROM, identityId: DID },
      [TO]: { id: TO, identityId: DID },
    };

    await handleFundsTransferred(
      tupleEvent({
        section: 'settlement',
        method: 'FundsTransferred',
        data: [
          codec(DID),
          account(FROM),
          account(TO),
          codec({ description: { fungible: { assetId: ASSET_ID, amount: 1 } }, memo: null }),
        ],
        specVersion: 8_001_010,
      })
    );

    expect(db.Holding[`${ASSET_ID}/${FROM}`].amount).toBe(BigInt(9));
    expect(db.Holding[`${ASSET_ID}/${TO}`].amount).toBe(BigInt(1));
  });
});
