/**
 * The genesis balance seeder (`src/seed/accountBalance.ts`). Without an opening snapshot every
 * balance the POLYX ledger derives is wrong by the genesis allocation, so this is a hard
 * prerequisite for the ledger, not an optimisation.
 */

import { seedAccountBalances } from '../../src/seed/accountBalance';
import { __resetStakingCaches } from '../../src/utils/staking';

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
    __resetStakingCaches();

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
          entries: jest.fn().mockResolvedValue([
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
      // no bond and no locks unless a test says otherwise
      staking: {
        bonded: jest.fn().mockResolvedValue({ toJSON: () => null }),
        ledger: jest.fn().mockResolvedValue({ toJSON: () => null }),
      },
      balances: { locks: jest.fn().mockResolvedValue({ toJSON: () => [] }) },
    };
  });

  it('creates one AccountBalance per funded account, skipping empty ones', async () => {
    const { seeded } = await seedAccountBalances({
      blockId: '0000000000',
      datetime: new Date(0),
      specVersion: 3000,
    });

    expect(seeded).toBe(2);
    expect(Object.keys(db['AccountBalance'])).toEqual([A, B]);
  });

  it('takes free/reserved verbatim and frozen as MAX(miscFrozen, feeFrozen) pre-v8', async () => {
    await seedAccountBalances({ blockId: '0000000000', datetime: new Date(0), specVersion: 3000 });

    expect(db['AccountBalance'][A]).toMatchObject({
      free: BigInt(1000000),
      reserved: BigInt(250),
      frozen: BigInt(400), // max(400, 100), not the sum
      total: BigInt(1000250),
      transferable: BigInt(999600), // free - frozen
    });
  });

  /**
   * The seeded freeze used to go in wholesale under a `'genesis'` lock. `bonded` reads the
   * `'staking '` lock, so a seeded staker was never bonded; and since `frozen` is the MAX over
   * locks, the `'genesis'` entry kept `frozen` pinned at the seeded amount forever, including
   * after the staker unbonded.
   */
  describe('attributing the seeded freeze', () => {
    it('leaves an unattributable freeze under a neutral lock, never the staking one', async () => {
      await seedAccountBalances({
        blockId: '0000000000',
        datetime: new Date(0),
        specVersion: 3000,
      });

      expect(db['AccountBalance'][A].locks).toEqual([{ lockId: 'residual', amount: BigInt(400) }]);
      expect(db['AccountBalance'][A].bonded).toBe(BigInt(0));
      expect(db['AccountBalance'][B].locks).toEqual([]);
    });

    it('pre-v8: files the bonded part as the staking lock, the rest as residual', async () => {
      (globalThis as any).api.query.staking = {
        bonded: jest.fn().mockResolvedValue(codec(null as unknown as string)),
        ledger: jest
          .fn()
          .mockResolvedValue({ toJSON: () => ({ total: '300', active: '300', unlocking: [] }) }),
      };

      await seedAccountBalances({
        blockId: '0000000000',
        datetime: new Date(0),
        specVersion: 3000,
      });

      expect(db['AccountBalance'][A].locks).toEqual([
        { lockId: 'staking ', amount: BigInt(300), reasons: 'staking' },
        { lockId: 'residual', amount: BigInt(400) },
      ]);
      // the bond is now visible as bonded, and frozen is still the MAX
      expect(db['AccountBalance'][A]).toMatchObject({
        bonded: BigInt(300),
        frozen: BigInt(400),
      });
    });

    it('v8: takes holds from chain, so a seeded bond is bonded and otherReserved is right', async () => {
      (globalThis as any).api.query.balances = {
        locks: jest.fn().mockResolvedValue({ toJSON: () => [] }),
        holds: jest.fn().mockResolvedValue({
          toJSON: () => [
            { id: { staking: 'Staking' }, amount: '200' },
            { id: { preimage: 'Preimage' }, amount: '50' },
          ],
        }),
      };

      await seedAccountBalances({
        blockId: '0000000000',
        datetime: new Date(0),
        specVersion: 8_000_000,
      });

      expect(db['AccountBalance'][A]).toMatchObject({
        reserved: BigInt(250),
        bonded: BigInt(200),
        otherReserved: BigInt(50),
      });
      expect(db['AccountBalance'][A].holds).toEqual([
        { reason: 'Staking', amount: BigInt(200) },
        { reason: 'Preimage', amount: BigInt(50) },
      ]);
      expect(db['AccountBalance'][A].locks).toEqual([{ lockId: 'residual', amount: BigInt(400) }]);
    });

    /**
     * An absent `holds` used to stand for "pre-v8", but it was only read when something was
     * reserved — so a v8 account with nothing reserved looked pre-v8 and had its freeze attributed
     * through the pre-v8 ledger read. The era decides now. This is also the lazily-migrated case: on
     * v8 an account the lock → hold migration has not reached yet has no holds and still carries its
     * old staking lock, and the lock is what keeps its bond counted.
     */
    it('v8 with nothing reserved: holds are known-empty and the bond comes from the staking lock', async () => {
      const ledger = jest.fn();
      (globalThis as any).api.query = {
        system: {
          account: {
            entries: jest
              .fn()
              .mockResolvedValue([accountEntry(B, { free: '5000', reserved: '0', frozen: '300' })]),
          },
        },
        balances: {
          holds: jest.fn(),
          locks: jest.fn().mockResolvedValue({ toJSON: () => [{ id: 'staking ', amount: '300' }] }),
        },
        staking: { ledger, bonded: jest.fn() },
      };

      await seedAccountBalances({
        blockId: '0000000000',
        datetime: new Date(0),
        specVersion: 8_000_000,
      });

      expect(db['AccountBalance'][B].holds).toEqual([]);
      expect(db['AccountBalance'][B]).toMatchObject({ bonded: BigInt(300), frozen: BigInt(300) });
      expect(db['AccountBalance'][B].locks).toEqual([
        { lockId: 'staking ', amount: BigInt(300), reasons: 'staking' },
      ]);
      // the pre-v8 route through `staking.ledger` is not taken on v8
      expect(ledger).not.toHaveBeenCalled();
      expect((globalThis as any).api.query.balances.holds).not.toHaveBeenCalled();
    });
  });
});
