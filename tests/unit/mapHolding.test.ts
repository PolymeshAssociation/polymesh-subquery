/**
 * `applyHoldingDelta` (src/mappings/entities/assets/mapAsset.ts) — the shared writer that keeps
 * the portfolio/account-grain `Holding` row and the identity-grain `AssetHolder` rollup in step,
 * and moves `Asset.holderCount` as the rollup crosses zero.
 */

import { applyHoldingDelta } from '../../src/mappings/entities/assets/mapAsset';
import { accountHolder, portfolioHolder } from '../../src/utils';

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
});
