/**
 * The POLYX ledger — one fixture per row of the "Event → pool transition" table in
 * docs/implementation/02-polyx-ledger.md, plus the properties the old `PolyxTransaction` model
 * could not satisfy: a `Reserved`/`Unreserved` round-trip returns the pools to their starting
 * values, and every movement writes a signed entry per account-side sharing one `movementId`.
 *
 * Events are built struct-style (v8), which is the surface A9 left entirely unindexed.
 */

import { SubstrateEvent } from '@subql/types';
import { EntryDirection, HoldReason, MovementKind, PolyxPool } from '../../src/types';
import {
  adjustLock,
  handleBalanceBurned,
  handleBalanceEndowed,
  handleBalanceFrozen,
  handleBalanceHeld,
  handleBalanceReleased,
  handleBalanceMinted,
  handleBalanceReserved,
  handleBalanceSet,
  handleBalanceSuspended,
  handleBalanceThawed,
  handleBalanceTransfer,
  handleBalanceUnreserved,
  handleBonded,
  handlePayoutStarted,
  handleReward,
  handleWithdrawn,
  handleDustLost,
  handleReserveRepatriated,
} from '../../src/mappings/entities/identities/mapPolyxLedger';

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

const storeGet = (): jest.Mock => (globalThis as any).store.get as jest.Mock;
const storeSet = (): jest.Mock => (globalThis as any).store.set as jest.Mock;
const storeGetByFields = (): jest.Mock => (globalThis as any).store.getByFields as jest.Mock;

const mockCodec = (value: string) => ({
  toString: () => value,
  toJSON: () => value,
  toU8a: () => Buffer.from(value),
});

let blockHeight = 1_000_000;

/** A struct-style event: the block metadata names every field. */
const structEvent = (
  section: string,
  method: string,
  fields: Record<string, string>,
  { specVersion = 8_000_000, atHeight }: { specVersion?: number; atHeight?: number } = {}
): SubstrateEvent => {
  if (atHeight === undefined) {
    blockHeight += 1;
  }
  const height = atHeight ?? blockHeight;

  return {
    idx: 4,
    block: {
      block: { header: { number: { toString: () => String(height) } } },
      timestamp: new Date('2024-06-01T12:00:00.000Z'),
      specVersion,
    },
    event: {
      section,
      method,
      data: Object.values(fields).map(mockCodec),
      meta: {
        fields: Object.keys(fields).map(name => ({
          name: { isSome: true, unwrap: () => mockCodec(name) },
          typeName: { isSome: true, unwrap: () => mockCodec('Dummy') },
        })),
      },
    },
  } as unknown as SubstrateEvent;
};

const balancesEvent = (
  method: string,
  fields: Record<string, string>,
  opts: { specVersion?: number; atHeight?: number } = {}
): SubstrateEvent => structEvent('balances', method, fields, opts);

/** A tuple-style event (pre-v8 Polymesh pallet): the block metadata carries no field names. */
const tupleEvent = (
  section: string,
  method: string,
  values: string[],
  specVersion: number
): SubstrateEvent => {
  blockHeight += 1;

  return {
    idx: 4,
    block: {
      block: { header: { number: { toString: () => String(blockHeight) } } },
      timestamp: new Date('2024-06-01T12:00:00.000Z'),
      specVersion,
    },
    event: {
      section,
      method,
      data: values.map(mockCodec),
      meta: {
        fields: values.map(() => ({
          name: { isSome: false },
          typeName: { isSome: true, unwrap: () => mockCodec('Dummy') },
        })),
      },
    },
  } as unknown as SubstrateEvent;
};

type Row = Record<string, any>;

let db: Record<string, Record<string, Row>>;

const clone = (value: Row): Row => {
  const copy: Row = {};
  for (const [k, v] of Object.entries(value)) {
    copy[k] = Array.isArray(v)
      ? v.map(item => (item && typeof item === 'object' ? { ...item } : item))
      : v;
  }
  return copy;
};

beforeEach(() => {
  db = {};
  blockHeight = 1_000_000;

  storeGet().mockImplementation((entity: string, id: string) => {
    if (entity === 'Account') {
      // Every test address is a known key, so `getOrCreateAccount` never reaches the chain.
      return Promise.resolve({ id, address: id, identityId: undefined });
    }
    const row = db[entity]?.[id];
    return Promise.resolve(row ? clone(row) : undefined);
  });

  storeSet().mockImplementation((entity: string, id: string, data: Row) => {
    (db[entity] ??= {})[id] = clone(data);
    return Promise.resolve();
  });

  storeGetByFields().mockResolvedValue([]);
});

const entries = (): Row[] => Object.values(db['PolyxEntry'] ?? {});
const balance = (address: string): Row | undefined => db['AccountBalance']?.[address];

describe('Event → pool transition', () => {
  it('Transfer: from/Free → to/Free, one debit + one credit sharing a movementId', async () => {
    await handleBalanceTransfer(
      balancesEvent('Transfer', { from: ALICE, to: BOB, amount: '1000' })
    );

    const rows = entries();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(r => r.movementId)).size).toBe(1);

    const debit = rows.find(r => r.direction === EntryDirection.Debit);
    const credit = rows.find(r => r.direction === EntryDirection.Credit);

    expect(debit).toMatchObject({
      accountId: ALICE,
      counterpartyAddress: BOB,
      pool: PolyxPool.Free,
      kind: MovementKind.Transfer,
      amount: BigInt(-1000),
      amountAbs: BigInt(1000),
    });
    expect(credit).toMatchObject({
      accountId: BOB,
      counterpartyAddress: ALICE,
      amount: BigInt(1000),
    });

    expect(balance(ALICE)?.free).toBe(BigInt(-1000));
    expect(balance(BOB)?.free).toBe(BigInt(1000));
  });

  it('Endowed: ∅ → who/Free', async () => {
    await handleBalanceEndowed(balancesEvent('Endowed', { account: BOB, freeBalance: '500' }));

    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      accountId: BOB,
      direction: EntryDirection.Credit,
      kind: MovementKind.Endowment,
      pool: PolyxPool.Free,
    });
    expect(balance(BOB)?.free).toBe(BigInt(500));
  });

  it('Reserved: who/Free → who/Reserved (Hold)', async () => {
    await handleBalanceReserved(balancesEvent('Reserved', { who: ALICE, amount: '300' }));

    const rows = entries();
    expect(rows.map(r => r.pool).sort()).toEqual([PolyxPool.Free, PolyxPool.Reserved].sort());
    expect(rows.every(r => r.kind === MovementKind.Hold)).toBe(true);
    expect(balance(ALICE)).toMatchObject({ free: BigInt(-300), reserved: BigInt(300) });
  });

  it('Unreserved: who/Reserved → who/Free (Release)', async () => {
    await handleBalanceUnreserved(balancesEvent('Unreserved', { who: ALICE, amount: '300' }));

    expect(balance(ALICE)).toMatchObject({ free: BigInt(300), reserved: BigInt(-300) });
    expect(entries().every(r => r.kind === MovementKind.Release)).toBe(true);
  });

  it('ReserveRepatriated to Free: from/Reserved → to/Free', async () => {
    await handleReserveRepatriated(
      balancesEvent('ReserveRepatriated', {
        from: ALICE,
        to: BOB,
        amount: '250',
        destinationStatus: 'Free',
      })
    );

    const credit = entries().find(r => r.direction === EntryDirection.Credit);
    expect(credit).toMatchObject({ accountId: BOB, pool: PolyxPool.Free });
    expect(balance(ALICE)?.reserved).toBe(BigInt(-250));
    expect(balance(BOB)?.free).toBe(BigInt(250));
  });

  it('Held{Staking}: who/Free → who/Reserved, and bonded tracks the hold', async () => {
    await handleBalanceHeld(
      balancesEvent('Held', { reason: 'Staking', who: ALICE, amount: '900' })
    );

    expect(balance(ALICE)).toMatchObject({
      free: BigInt(-900),
      reserved: BigInt(900),
      bonded: BigInt(900),
    });
    expect(entries().every(r => r.holdReason === HoldReason.Staking)).toBe(true);
  });

  it('Released{Staking}: who/Reserved → who/Free, unwinding the hold', async () => {
    await handleBalanceHeld(
      balancesEvent('Held', { reason: 'Staking', who: ALICE, amount: '900' })
    );
    await handleBalanceReleased(
      balancesEvent('Released', { reason: 'Staking', who: ALICE, amount: '900' })
    );

    expect(balance(ALICE)).toMatchObject({
      free: BigInt(0),
      reserved: BigInt(0),
      bonded: BigInt(0),
    });
  });

  it('Burned: who/Free → ∅', async () => {
    await handleBalanceBurned(balancesEvent('Burned', { who: ALICE, amount: '120' }));

    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      direction: EntryDirection.Debit,
      kind: MovementKind.Burn,
    });
    expect(balance(ALICE)?.free).toBe(BigInt(-120));
  });

  it('Slashed: who/Free → ∅ with kind Slash and totalSlashed', async () => {
    await handleBalanceBurned(balancesEvent('Slashed', { who: ALICE, amount: '75' }));

    expect(entries()[0].kind).toBe(MovementKind.Slash);
    expect(balance(ALICE)).toMatchObject({ free: BigInt(-75), totalSlashed: BigInt(75) });
  });

  it('Minted: ∅ → who/Free', async () => {
    await handleBalanceMinted(balancesEvent('Minted', { who: BOB, amount: '4000' }));

    expect(entries()[0]).toMatchObject({
      direction: EntryDirection.Credit,
      kind: MovementKind.Mint,
    });
    expect(balance(BOB)?.free).toBe(BigInt(4000));
  });

  it('DustLost: account/Free → ∅', async () => {
    await handleDustLost(balancesEvent('DustLost', { account: ALICE, amount: '7' }));

    expect(entries()[0].kind).toBe(MovementKind.DustLost);
    expect(balance(ALICE)?.free).toBe(BigInt(-7));
  });

  it('Suspended: who/Free → ∅ (A3 — handler now exists)', async () => {
    await handleBalanceSuspended(balancesEvent('Suspended', { who: ALICE, amount: '9' }));

    expect(entries()).toHaveLength(1);
    expect(balance(ALICE)?.free).toBe(BigInt(-9));
  });
});

describe('properties the one-column model could not satisfy', () => {
  it('Reserved then Unreserved returns free and reserved to their starting values', async () => {
    await handleBalanceReserved(balancesEvent('Reserved', { who: ALICE, amount: '600' }));
    await handleBalanceUnreserved(balancesEvent('Unreserved', { who: ALICE, amount: '600' }));

    expect(balance(ALICE)).toMatchObject({ free: BigInt(0), reserved: BigInt(0) });
  });

  it('every movement is recorded as a signed entry: SUM(amount) is the net delta', async () => {
    await handleBalanceMinted(balancesEvent('Minted', { who: ALICE, amount: '1000' }));
    await handleBalanceBurned(balancesEvent('Burned', { who: ALICE, amount: '250' }));

    const net = entries()
      .filter(r => r.accountId === ALICE)
      .reduce((sum, r) => sum + r.amount, BigInt(0));

    expect(net).toBe(BigInt(750));
    expect(balance(ALICE)?.free).toBe(BigInt(750));
  });

  it('BalanceSet sets the pool absolutely and does not corrupt subsequent totals', async () => {
    await handleBalanceMinted(balancesEvent('Minted', { who: ALICE, amount: '1000' }));

    await handleBalanceSet(balancesEvent('BalanceSet', { who: ALICE, free: '5000' }));

    // 5000, not 1000 + 5000
    expect(balance(ALICE)?.free).toBe(BigInt(5000));

    const adjustment = entries().find(r => r.kind === MovementKind.BalanceSetAdjustment);
    expect(adjustment).toMatchObject({ amount: BigInt(4000), freeAfter: BigInt(5000) });

    await handleBalanceBurned(balancesEvent('Burned', { who: ALICE, amount: '500' }));
    expect(balance(ALICE)?.free).toBe(BigInt(4500));
  });

  it('BalanceSet writes a debit adjustment when it lowers the balance, and a per-pool entry pre-v8', async () => {
    await handleBalanceMinted(balancesEvent('Minted', { who: BOB, amount: '9000' }));

    await handleBalanceSet(
      balancesEvent('BalanceSet', {
        identityId: '0x00',
        account: BOB,
        free: '8000',
        reserved: '250',
      })
    );

    expect(balance(BOB)).toMatchObject({ free: BigInt(8000), reserved: BigInt(250) });

    const adjustments = entries().filter(r => r.kind === MovementKind.BalanceSetAdjustment);
    expect(adjustments.map(r => [r.pool, r.amount]).sort()).toEqual(
      [
        [PolyxPool.Free, BigInt(-1000)],
        [PolyxPool.Reserved, BigInt(250)],
      ].sort()
    );
  });

  it('frozen is the MAX over active locks, not their sum', async () => {
    await handleBalanceMinted(balancesEvent('Minted', { who: ALICE, amount: '1000' }));

    await adjustLock(ALICE, 'staking ', BigInt(100), '0000009999');
    await adjustLock(ALICE, 'pips    ', BigInt(150), '0000009999');

    expect(balance(ALICE)?.frozen).toBe(BigInt(150)); // not 250
    expect(balance(ALICE)?.transferable).toBe(BigInt(850)); // free 1000 - frozen 150
  });

  it('a lock writes no PolyxEntry and does not move the pools', async () => {
    await handleBalanceMinted(balancesEvent('Minted', { who: ALICE, amount: '1000' }));
    const entriesAfterMint = entries().length;

    await handleBalanceFrozen(balancesEvent('Frozen', { who: ALICE, amount: '400' }));

    expect(entries().length).toBe(entriesAfterMint); // no new entry
    expect(balance(ALICE)).toMatchObject({
      free: BigInt(1000),
      reserved: BigInt(0),
      frozen: BigInt(400),
    });

    await handleBalanceThawed(balancesEvent('Thawed', { who: ALICE, amount: '400' }));
    expect(balance(ALICE)?.frozen).toBe(BigInt(0));
  });

  it('carries the balance-after snapshot on each entry', async () => {
    await handleBalanceMinted(balancesEvent('Minted', { who: ALICE, amount: '1000' }));
    await handleBalanceReserved(balancesEvent('Reserved', { who: ALICE, amount: '400' }));

    const last = entries()
      .filter(r => r.accountId === ALICE)
      .sort((a, b) => a.id.localeCompare(b.id))
      .at(-1);

    expect(last).toMatchObject({ freeAfter: BigInt(600), reservedAfter: BigInt(400) });
  });
});

describe('staking — era-dependent, inverted at v8 (A10 / A6)', () => {
  it('v7 Bonded produces no PolyxEntry and raises frozen via the staking lock', async () => {
    await handleBalanceMinted(balancesEvent('Minted', { who: ALICE, amount: '10000' }));
    const beforeEntries = entries().length;

    await handleBonded(tupleEvent('staking', 'Bonded', ['0xdid', ALICE, '4000'], 7_004_001));

    expect(entries().length).toBe(beforeEntries); // no movement row
    expect(balance(ALICE)).toMatchObject({
      free: BigInt(10000), // unchanged — pre-v8 bonding moves nothing
      frozen: BigInt(4000),
      bonded: BigInt(4000),
      transferable: BigInt(6000),
    });
  });

  it('v7 Withdrawn lowers the staking lock', async () => {
    await handleBalanceMinted(balancesEvent('Minted', { who: ALICE, amount: '10000' }));
    await handleBonded(tupleEvent('staking', 'Bonded', ['0xdid', ALICE, '4000'], 7_004_001));

    await handleWithdrawn(tupleEvent('staking', 'Withdrawn', [ALICE, '1500'], 7_004_001));

    expect(balance(ALICE)?.frozen).toBe(BigInt(2500));
  });

  it('v8 Bonded is ledger state only — no entry, no lock (the move is the paired Held)', async () => {
    await handleBalanceMinted(balancesEvent('Minted', { who: ALICE, amount: '10000' }));
    const beforeEntries = entries().length;

    await handleBonded(
      balancesEvent('Bonded', { stash: ALICE, amount: '4000' }, { specVersion: 8_000_000 })
    );

    expect(entries().length).toBe(beforeEntries);
    expect(balance(ALICE)).toMatchObject({
      free: BigInt(10000),
      frozen: BigInt(0),
      bonded: BigInt(0),
    });

    // the actual v8 bonding movement:
    await handleBalanceHeld(
      balancesEvent('Held', { reason: 'Staking', who: ALICE, amount: '4000' })
    );
    expect(balance(ALICE)).toMatchObject({
      free: BigInt(6000),
      reserved: BigInt(4000),
      bonded: BigInt(4000),
    });
  });

  it('pre-v8 Reward resolves an explicit Account payee — credited to that account, not the stash', async () => {
    const PAYEE = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy';
    (globalThis as any).api.query = {
      staking: {
        payee: jest.fn().mockResolvedValue({ toJSON: () => ({ account: PAYEE }) }),
        bonded: jest.fn().mockResolvedValue({ toJSON: () => null }),
      },
    };

    await handleReward(tupleEvent('staking', 'Reward', ['0xdid', ALICE, '900'], 7_004_001));

    const reward = entries().find(r => r.kind === MovementKind.StakingReward);
    expect(reward?.accountId).toBe(PAYEE);
    expect(reward?.accountId).not.toBe(ALICE);
    expect(balance(PAYEE)?.free).toBe(BigInt(900));

    (globalThis as any).api.query = {};
  });

  it('staking Reward is ∅ → stash/Free with the era from the preceding PayoutStarted', async () => {
    await handlePayoutStarted(
      structEvent(
        'staking',
        'PayoutStarted',
        { eraIndex: '742', validatorStash: BOB, page: '0', next: '0' },
        { atHeight: 5_000_000 }
      )
    );
    await handleReward(
      structEvent(
        'staking',
        'Rewarded',
        { stash: ALICE, dest: 'Staked', amount: '333' },
        { atHeight: 5_000_000 }
      )
    );

    const reward = entries().find(r => r.kind === MovementKind.StakingReward);
    expect(reward).toMatchObject({
      accountId: ALICE,
      direction: EntryDirection.Credit,
      amount: BigInt(333),
      eraIndex: 742,
    });
    expect(balance(ALICE)).toMatchObject({ free: BigInt(333), totalRewards: BigInt(333) });
  });
});
