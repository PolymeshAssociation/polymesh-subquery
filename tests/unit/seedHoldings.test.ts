/**
 * The genesis holding seeder (`src/seed/holding.ts`). `Holding` is rebuilt from the movement
 * stream, so — exactly as with `seedAccountBalances` for the POLYX ledger — it needs an opening
 * snapshot or every derived holding is short by the start-block allocation.
 */

import { seedHoldings } from '../../src/seed/holding';

const ASSET_A = '0x11111111111111111111111111111111';
const ASSET_B = '0x22222222222222222222222222222222';
const DID_1 = '0x01'.padEnd(66, '0');
const DID_2 = '0x02'.padEnd(66, '0');

const storeGet = (): jest.Mock => (globalThis as any).store.get as jest.Mock;
const storeSet = (): jest.Mock => (globalThis as any).store.set as jest.Mock;

const codec = (value: unknown) => ({
  toString: () => (typeof value === 'string' ? value : JSON.stringify(value)),
  toJSON: () => value,
});

const portfolio = (did: string, number?: number) =>
  codec({ did, kind: number ? { user: number } : { default: null } });

/** `[storageKey, balance]` pairs as `portfolioAssetBalances.entries()` yields them. */
const balanceEntry = (did: string, number: number | undefined, assetId: string, amount: string) => [
  { args: [portfolio(did, number), codec(assetId)] },
  codec(amount),
];

describe('seedHoldings', () => {
  let db: Record<string, Record<string, any>>;

  beforeEach(() => {
    db = {};

    storeGet().mockImplementation((entity: string, id: string) => {
      if (entity === 'Asset' && (id === ASSET_A || id === ASSET_B)) {
        return Promise.resolve(db['Asset']?.[id] ?? { id, assetId: id, holderCount: 0 });
      }
      return Promise.resolve(db[entity]?.[id]);
    });
    storeSet().mockImplementation((entity: string, id: string, data: any) => {
      (db[entity] ??= {})[id] = { ...data };
      return Promise.resolve();
    });

    (globalThis as any).api.runtimeVersion.specVersion.toNumber = () => 8000000;
    (globalThis as any).api.query = {
      portfolio: {
        portfolioAssetBalances: {
          entries: jest.fn().mockResolvedValue([
            balanceEntry(DID_1, 0, ASSET_A, '1000'),
            balanceEntry(DID_1, 1, ASSET_A, '500'),
            balanceEntry(DID_2, 0, ASSET_A, '250'),
            balanceEntry(DID_2, 0, ASSET_B, '0'), // zero balances are skipped
            balanceEntry(DID_1, 0, '0xdeadbeefdeadbeefdeadbeefdeadbeef', '9'), // unknown asset skipped
          ]),
        },
      },
    };
  });

  it('creates one Holding per funded (portfolio, asset), skipping zero and unknown-asset rows', async () => {
    const { seeded } = await seedHoldings({ blockId: '0000000000', datetime: new Date(0) });

    expect(seeded).toBe(3);
    expect(Object.keys(db['Holding']).sort()).toEqual(
      [`${ASSET_A}/${DID_1}/0`, `${ASSET_A}/${DID_1}/1`, `${ASSET_A}/${DID_2}/0`].sort()
    );
    expect(db['Holding'][`${ASSET_A}/${DID_1}/1`]).toMatchObject({
      amount: BigInt(500),
      holderKind: 'Portfolio',
      portfolioId: `${DID_1}/1`,
      identityId: DID_1,
      nftCount: 0,
    });
  });

  it('rolls Holding rows up into one AssetHolder per (asset, identity)', async () => {
    await seedHoldings({ blockId: '0000000000', datetime: new Date(0) });

    expect(db['AssetHolder'][`${ASSET_A}/${DID_1}`].amount).toBe(BigInt(1500));
    expect(db['AssetHolder'][`${ASSET_A}/${DID_2}`].amount).toBe(BigInt(250));
  });

  it('sets Asset.holderCount to the number of identities holding a positive balance', async () => {
    await seedHoldings({ blockId: '0000000000', datetime: new Date(0) });

    expect(db['Asset'][ASSET_A].holderCount).toBe(2);
  });

  it('no-ops when the portfolio pallet has no balance storage', async () => {
    (globalThis as any).api.query = { portfolio: {} };

    const { seeded } = await seedHoldings({ blockId: '0000000000', datetime: new Date(0) });

    expect(seeded).toBe(0);
  });
});
