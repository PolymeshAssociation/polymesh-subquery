/**
 * The genesis balance seeder (`src/seed/accountBalance.ts`). Without an opening snapshot every
 * balance the POLYX ledger derives is wrong by the genesis allocation, so this is a hard
 * prerequisite for the ledger, not an optimisation.
 */

import { seedAccountBalances } from '../../src/seed/accountBalance';

const A = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const B = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

const storeGet = (): jest.Mock => (globalThis as any).store.get as jest.Mock;
const storeSet = (): jest.Mock => (globalThis as any).store.set as jest.Mock;

const codec = (value: string) => ({ toString: () => value, toJSON: () => value });

/** `[storageKey, accountInfo]` pairs as `api.query.system.account.entries()` yields them. */
const accountEntry = (
  address: string,
  data: {
    free: string;
    reserved?: string;
    miscFrozen?: string;
    feeFrozen?: string;
    frozen?: string;
  }
) => [
  { args: [codec(address)] },
  {
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, codec(v as string)])),
  },
];

describe('seedAccountBalances', () => {
  let db: Record<string, Record<string, any>>;

  beforeEach(() => {
    db = {};

    storeGet().mockImplementation((entity: string, id: string) => {
      if (entity === 'Account') {
        return Promise.resolve({ id, address: id, identityId: undefined });
      }
      return Promise.resolve(db[entity]?.[id]);
    });
    storeSet().mockImplementation((entity: string, id: string, data: any) => {
      (db[entity] ??= {})[id] = { ...data };
      return Promise.resolve();
    });

    (globalThis as any).api.query = {
      system: {
        account: {
          entries: jest
            .fn()
            .mockResolvedValue([
              accountEntry(A, {
                free: '1000000',
                reserved: '250',
                miscFrozen: '400',
                feeFrozen: '100',
              }),
              accountEntry(B, { free: '5000', reserved: '0' }),
              accountEntry('5zeroBalance', { free: '0', reserved: '0' }),
            ]),
        },
      },
    };
  });

  it('creates one AccountBalance per funded account, skipping empty ones', async () => {
    const { seeded } = await seedAccountBalances({ blockId: '0000000000', datetime: new Date(0) });

    expect(seeded).toBe(2);
    expect(Object.keys(db['AccountBalance'])).toEqual([A, B]);
  });

  it('takes free/reserved verbatim and frozen as MAX(miscFrozen, feeFrozen) pre-v8', async () => {
    await seedAccountBalances({ blockId: '0000000000', datetime: new Date(0) });

    expect(db['AccountBalance'][A]).toMatchObject({
      free: BigInt(1000000),
      reserved: BigInt(250),
      frozen: BigInt(400), // max(400, 100), not the sum
      total: BigInt(1000250),
      transferable: BigInt(999600), // free - frozen
    });
  });

  it('records a genesis freeze as a single lock so frozen stays a MAX going forward', async () => {
    await seedAccountBalances({ blockId: '0000000000', datetime: new Date(0) });

    expect(db['AccountBalance'][A].locks).toEqual([
      { lockId: 'genesis', amount: BigInt(400), reasons: undefined },
    ]);
    expect(db['AccountBalance'][B].locks).toEqual([]);
  });
});
