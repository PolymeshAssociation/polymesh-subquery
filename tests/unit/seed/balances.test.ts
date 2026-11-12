/**
 * Opening balances, from `system.account`, with each freeze attributed as the POLYX ledger keeps it:
 * a bond as the staking lock (before 8.0) or the staking hold (from 8.0), and what's unexplained as
 * the residual lock. Without them every balance the ledger derives is wrong by the opening
 * allocation.
 */
import { SEED_EVENT_ID } from '../../../src/mappings/consts';
import { seed } from '../../../src/seed/seeder';
import { SEEDERS } from '../../../src/seed/seeders';
import { accountRows } from '../../../src/seed/seeders/identities';
import { snapshotAtParent } from '../../../src/seed/snapshot';
import { fakeChain, FakeChain, genesisChain } from './fakeChain';
import { byId, golden } from './goldens';

const A = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const B = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const CONTROLLER = '5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y';
const DID = `0x${'01'.repeat(32)}`;

const seedBalances = (chain: FakeChain, blockId = '0000001000') =>
  seed(
    snapshotAtParent(chain.block),
    {
      block: chain.block,
      blockId,
      eventId: SEED_EVENT_ID,
      datetime: new Date(0),
      specVersion: chain.specVersion,
    },
    {
      seeders: SEEDERS.filter(({ entity }) => ['AccountBalance', 'Account'].includes(entity)),
      accountRows,
    }
  );

const info = (data: Record<string, number>) => ({
  nonce: 0,
  consumers: 0,
  providers: 1,
  sufficients: 0,
  data,
});

/** 8.0's account data, one `frozen` */
const account = (free: number, reserved: number, frozen: number) =>
  info({ free, reserved, frozen, flags: 0 });

/** Before 8.0 two freezes, of which the balance's is the larger */
const accountBefore8 = (free: number, reserved: number, miscFrozen: number, feeFrozen: number) =>
  info({ free, reserved, miscFrozen, feeFrozen });

const balanceOf = (chain: FakeChain, address: string) =>
  byId(chain.rows('AccountBalance'))[address];

describe.each(['testnet', 'mainnet'] as const)('the %s genesis', chainName => {
  it('seeds the opening balances the genesis handler wrote', async () => {
    const chain = genesisChain(chainName);
    await seedBalances(chain, '0000000000');

    expect(byId(chain.rows('AccountBalance'))).toEqual(byId(golden(chainName).AccountBalance));
  });
});

describe('before 8.0', () => {
  let chain: FakeChain;

  beforeEach(async () => {
    chain = fakeChain(7_002_000);
    chain.put('system.account', [A], accountBefore8(1_000_000, 250, 400, 100));
    chain.put('system.account', [B], accountBefore8(5_000, 0, 0, 0));
    chain.put('system.account', [CONTROLLER], accountBefore8(0, 0, 0, 0));
    chain.put('identity.keyRecords', [A], { PrimaryKey: DID });
    // A's bond is the ledger its controller keeps, and the staking lock is its total
    chain.put('staking.bonded', [A], CONTROLLER);
    chain.put('staking.ledger', [CONTROLLER], {
      stash: A,
      total: 300,
      active: 300,
      unlocking: [],
      claimedRewards: [],
    });
    chain.put(
      'balances.locks',
      [A],
      [
        { id: 'staking ', amount: 300, reasons: 'All' },
        { id: 'pips    ', amount: 400, reasons: 'All' },
      ]
    );
    await seedBalances(chain);
  });

  it('seeds a balance for each funded account, and none for an empty one', () => {
    expect(
      chain
        .rows('AccountBalance')
        .map(({ id }) => id)
        .sort()
    ).toEqual([A, B].sort());
  });

  it('takes free, reserved and the larger freeze from the chain, and the identity from its key record', () => {
    expect(balanceOf(chain, A)).toMatchObject({
      identityId: DID,
      free: '1000000',
      reserved: '250',
      frozen: '400',
      totalReceived: '0',
      movementCount: 0,
    });
  });

  it('lists the locks by id, in the order the handlers keep them', () => {
    expect((balanceOf(chain, A).locks as { lockId: string }[]).map(({ lockId }) => lockId)).toEqual(
      ['pips    ', 'staking ']
    );
  });

  it('files the bond, the ledger its controller keeps, as the staking lock', () => {
    expect(balanceOf(chain, A)).toMatchObject({ bonded: '300' });
    expect(
      (balanceOf(chain, A).locks as { lockId: string }[]).map(({ lockId }) => lockId)
    ).toContain('staking ');
  });

  it('gives each funded account an Account row, unlinked when no key record names it', () => {
    expect(byId(chain.rows('Account'))[B]).toMatchObject({ keyRole: 'Unlinked' });
  });

  // testnet 26,356,000: 207 accounts the chain holds with a nonce and nothing else
  it('gives an account the chain holds an Account row though it holds no POLYX, and no balance row', () => {
    expect(byId(chain.rows('Account'))[CONTROLLER]).toMatchObject({ keyRole: 'Unlinked' });
    expect(balanceOf(chain, CONTROLLER)).toBeUndefined();
  });
});

describe('from 8.0', () => {
  it('takes the bond from the staking hold', async () => {
    const chain = fakeChain(8_000_020);
    chain.put('system.account', [A], account(1_000_000, 500, 0));
    chain.put('balances.holds', [A], [{ id: { Staking: 'Staking' }, amount: 500 }]);
    await seedBalances(chain);

    expect(balanceOf(chain, A)).toMatchObject({ bonded: '500', otherReserved: '0' });
  });

  // testnet 26,326,408: the runtime's types read this reason as one byte, and would take the
  // amount from one byte early, as 53,760,001
  it('reads a hold the runtime types misread from its raw bytes, a two-byte reason and its amount', async () => {
    const chain = fakeChain(8_001_020);
    chain.put('system.account', [A], account(0, 210_000, 0));
    chain.putRaw('balances.holds', [A], '0x042e0150340300000000000000000000000000');
    await seedBalances(chain);

    expect(balanceOf(chain, A).holds).toEqual([expect.objectContaining({ amount: '210000' })]);
  });

  it('reads nothing reserved as no holds at all', async () => {
    const chain = fakeChain(8_000_020);
    chain.put('system.account', [A], account(1_000, 0, 0));
    await seedBalances(chain);

    expect(balanceOf(chain, A)).toMatchObject({ holds: [], bonded: '0' });
  });
});
