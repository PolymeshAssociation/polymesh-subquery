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
  handleBalanceTransferWithMemo,
  handleBalanceUnlocked,
  handleBalanceUnreserved,
  handleBonded,
  handlePayoutStarted,
  handleReward,
  handleWithdrawn,
  handleDustLost,
  handleReserveRepatriated,
  handleStakingSlash,
  handleTransactionFeeCharged,
  handleTransferAndHold,
  handleTreasuryDisbursement,
  handleTreasuryReimbursement,
} from '../../src/mappings/entities/identities/mapPolyxLedger';
import { getAccountId, systematicIssuers } from '../../src/mappings/consts';
import { __resetStakingCaches } from '../../src/utils/staking';

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

const storeGet = (): jest.Mock => (globalThis as any).store.get as jest.Mock;
const storeSet = (): jest.Mock => (globalThis as any).store.set as jest.Mock;
const storeGetByFields = (): jest.Mock => (globalThis as any).store.getByFields as jest.Mock;

/**
 * `toString()` is `stringify(toJSON())` in polkadot-js, so a composite enum such as v8's
 * `RuntimeHoldReason` stringifies to `'{"staking":"Staking"}'`, not `'Staking'`. Mirroring that
 * here is what lets a fixture carry the shape the chain really emits — a plain string mock hid
 * the hold-reason defect (F8) entirely.
 */
const mockCodec = (value: unknown) => ({
  toString: () => (typeof value === 'string' ? value : JSON.stringify(value)),
  toJSON: () => value,
  toU8a: () => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
});

let blockHeight = 1_000_000;

/** A struct-style event: the block metadata names every field. */
const structEvent = (
  section: string,
  method: string,
  fields: Record<string, unknown>,
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
  fields: Record<string, unknown>,
  opts: { specVersion?: number; atHeight?: number } = {}
): SubstrateEvent => structEvent('balances', method, fields, opts);

/**
 * The shape a v8 `RuntimeHoldReason` really decodes to: a composite enum, the pallet's own reason
 * nested under the pallet name. Confirmed against live mainnet (`8000020`) and testnet (`8001010`)
 * metadata, where `createType('RuntimeHoldReason', { Staking: 'Staking' }).toString()` is
 * `'{"staking":"Staking"}'`.
 */
const STAKING_HOLD_REASON = { staking: 'Staking' };

/**
 * A run of events emitted by one extrinsic, in order, sharing a block — which is what the
 * cross-event pairings key on. Each gets its own event index so their entries do not collide.
 */
const extrinsicEvents = (
  height: number,
  emitted: [section: string, method: string, fields: Record<string, unknown>][],
  { specVersion = 8_000_000 }: { specVersion?: number } = {}
): SubstrateEvent[] =>
  emitted.map(([section, method, fields], index) => {
    const event = structEvent(section, method, fields, { atHeight: height, specVersion });

    (event as { idx: number }).idx = index;
    (event as { extrinsic?: unknown }).extrinsic = {
      idx: 1,
      // `getEventParams` resolves the call, and the eth-transact check walks into it
      extrinsic: { method: { section: 'utility', method: 'batchAll' } },
      success: true,
    };

    return event;
  });

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
  __resetStakingCaches();
  db = {};
  blockHeight = 1_000_000;
  (globalThis as any).api.registry = { chainSS58: 42 };

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

  /**
   * A real `getByFields` over the in-memory rows, not a blanket `[]`. Every cross-event pairing in
   * this module (endowment ⇄ transfer, deposit ⇄ endowment, withdrawal ⇄ fee, deposit ⇄ reward)
   * reads back entries written earlier in the same block, so stubbing it empty meant none of those
   * paths were ever exercised.
   */
  storeGetByFields().mockImplementation((entity: string, filter: [string, string, unknown][]) =>
    Promise.resolve(
      Object.values(db[entity] ?? {})
        .filter(row => filter.every(([field, op, value]) => op === '=' && row[field] === value))
        .map(clone)
    )
  );
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

  it('Held{Staking}: decodes the real v8 composite RuntimeHoldReason, not just a bare string', async () => {
    // F8: `{ staking: 'Staking' }` stringifies to `'{"staking":"Staking"}'`, which matched no
    // HoldReason member — so every v8 hold landed as `Unknown` and `bonded` was always 0.
    await handleBalanceHeld(
      balancesEvent('Held', { reason: STAKING_HOLD_REASON, who: ALICE, amount: '900' })
    );

    expect(balance(ALICE)).toMatchObject({
      reserved: BigInt(900),
      bonded: BigInt(900),
      otherReserved: BigInt(0),
    });
    expect(balance(ALICE)?.holds).toEqual([{ reason: HoldReason.Staking, amount: BigInt(900) }]);
    expect(entries().every(r => r.holdReason === HoldReason.Staking)).toBe(true);
  });

  it('Held: an unrecognised hold reason still decodes as Unknown', async () => {
    await handleBalanceHeld(
      balancesEvent('Held', { reason: { somethingNew: 'Whatever' }, who: ALICE, amount: '5' })
    );

    expect(entries().every(r => r.holdReason === HoldReason.Unknown)).toBe(true);
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

  it('TreasuryReimbursement credits the treasury pallet account, not the fee payer', async () => {
    const payerDid = '0x8015a1702789fedf8474a042af07ba6a37f94e8d24b4eed89414e6eb79df084e';
    const treasury = getAccountId(systematicIssuers.treasury.accountId, 42);

    await handleTreasuryReimbursement(
      tupleEvent('treasury', 'TreasuryReimbursement', [payerDid, '400'], 4_000_000)
    );

    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      accountId: treasury,
      direction: EntryDirection.Credit,
      kind: MovementKind.TreasuryReimbursement,
      amount: BigInt(400),
    });
    expect(entries()[0].accountId).not.toBe(payerDid);
    expect(balance(treasury)?.free).toBe(BigInt(400));
  });

  it('TreasuryDisbursement debits the treasury pallet account, not the authorising committee', async () => {
    const committeeDid = '0x73797374656d3a676f7665726e616e63655f636f6d6d69747465650000000000';
    const recipientDid = '0x8015a1702789fedf8474a042af07ba6a37f94e8d24b4eed89414e6eb79df084e';
    const treasury = getAccountId(systematicIssuers.treasury.accountId, 42);

    // pre-5.0.0 shape carries no recipient account and no paired balances.Transfer
    await handleTreasuryDisbursement(
      tupleEvent(
        'treasury',
        'TreasuryDisbursement',
        [committeeDid, recipientDid, BOB, '4014'],
        3010
      )
    );

    const debit = entries().find(r => r.direction === EntryDirection.Debit);
    const credit = entries().find(r => r.direction === EntryDirection.Credit);

    expect(debit).toMatchObject({
      accountId: treasury,
      kind: MovementKind.TreasuryDisbursement,
      amount: BigInt(-4014),
    });
    expect(credit?.accountId).toBe(BOB);
    expect(entries().some(r => r.accountId === committeeDid)).toBe(false);
    expect(balance(treasury)?.free).toBe(BigInt(-4014));
    expect(balance(BOB)?.free).toBe(BigInt(4014));
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

    expect(entries()).toHaveLength(entriesAfterMint); // no new entry
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

    expect(entries()).toHaveLength(beforeEntries); // no movement row
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

    expect(entries()).toHaveLength(beforeEntries);
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

  describe('the v5–v7 lock → v8 hold storage migration', () => {
    it('a v8 Held{Staking} moves the bonded amount free → reserved, lock still standing', async () => {
      await handleBalanceMinted(balancesEvent('Minted', { who: ALICE, amount: '10000' }));
      await adjustLock(ALICE, 'staking ', BigInt(4000), '0000001000000', 'staking');

      // pass 1 of the migration — Held with no paired Deposit
      await handleBalanceHeld(
        balancesEvent('Held', { reason: 'Staking', who: ALICE, amount: '4000' })
      );

      expect(balance(ALICE)).toMatchObject({
        free: BigInt(6000),
        reserved: BigInt(4000),
        frozen: BigInt(4000), // the "staking " lock is deliberately kept — chain frozen is still 4000
        bonded: BigInt(4000),
      });
    });

    it('a v8 Unlocked that covers the staking lock clears it (pass 2)', async () => {
      await handleBalanceMinted(balancesEvent('Minted', { who: ALICE, amount: '10000' }));
      await adjustLock(ALICE, 'staking ', BigInt(4000), '0000001000000', 'staking');
      await handleBalanceHeld(
        balancesEvent('Held', { reason: 'Staking', who: ALICE, amount: '4000' })
      );

      await handleBalanceUnlocked(
        balancesEvent('Unlocked', { who: ALICE, amount: '4000' }, { specVersion: 8_000_000 })
      );

      expect(balance(ALICE)).toMatchObject({
        free: BigInt(6000),
        reserved: BigInt(4000),
        frozen: BigInt(0), // lock gone
        bonded: BigInt(4000), // still bonded, now via the hold
        transferable: BigInt(6000),
      });
      expect(balance(ALICE)?.locks ?? []).toHaveLength(0);
    });

    it('a pre-v8 Unlocked leaves the staking lock alone (generic "balances" lock only)', async () => {
      await handleBalanceMinted(balancesEvent('Minted', { who: ALICE, amount: '10000' }));
      await adjustLock(ALICE, 'staking ', BigInt(4000), '0000001000000', 'staking');

      await handleBalanceUnlocked(
        balancesEvent('Unlocked', { who: ALICE, amount: '10' }, { specVersion: 7_004_001 })
      );

      expect(balance(ALICE)?.locks?.find((l: any) => l.lockId === 'staking ')?.amount).toBe(
        BigInt(4000)
      );
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

  it('pre-v8 Reward with a Staked payee credits free AND raises the staking lock', async () => {
    (globalThis as any).api.query = {
      staking: {
        payee: jest.fn().mockResolvedValue({ toJSON: () => 'Staked' }),
        bonded: jest.fn().mockResolvedValue({ toJSON: () => null }),
      },
    };

    await handleReward(tupleEvent('staking', 'Reward', ['0xdid', ALICE, '500'], 7_004_001));

    expect(balance(ALICE)).toMatchObject({
      free: BigInt(500),
      frozen: BigInt(500), // restaked — locked in the same step
      bonded: BigInt(500),
      transferable: BigInt(0),
    });

    (globalThis as any).api.query = {};
  });

  describe('the staking lock is read from staking.ledger.total, not accumulated', () => {
    const mockLedger = (total: string, bonded: string | null = null) => {
      (globalThis as any).api.query = {
        staking: {
          payee: jest.fn().mockResolvedValue({ toJSON: () => 'Staked' }),
          bonded: jest.fn().mockResolvedValue({ toJSON: () => bonded }),
          ledger: jest.fn().mockResolvedValue({ toJSON: () => ({ total, active: total }) }),
        },
      };
    };

    afterEach(() => {
      (globalThis as any).api.query = {};
    });

    it('v7 Bonded pins the lock to ledger.total, ignoring the event amount', async () => {
      await handleBalanceMinted(balancesEvent('Minted', { who: ALICE, amount: '10000' }));
      mockLedger('4200'); // chain: 4200 bonded (4000 + a compounded 200 the event never carried)

      await handleBonded(tupleEvent('staking', 'Bonded', ['0xdid', ALICE, '4000'], 7_004_001));

      expect(balance(ALICE)).toMatchObject({ frozen: BigInt(4200), bonded: BigInt(4200) });
    });

    it('a restaked Staked reward pins the lock to ledger.total (capped below the gross reward)', async () => {
      await handleBalanceMinted(balancesEvent('Minted', { who: ALICE, amount: '10000' }));
      mockLedger('4000000000000'); // at the max-bond cap

      await handleReward(tupleEvent('staking', 'Reward', ['0xdid', ALICE, '900'], 7_004_001));

      // free still takes the whole reward; the lock is whatever the ledger says, not += 900
      expect(balance(ALICE)).toMatchObject({
        free: BigInt(10900),
        frozen: BigInt('4000000000000'),
      });
    });

    it('v7 Withdrawn pins the lock to the reduced ledger.total', async () => {
      await handleBalanceMinted(balancesEvent('Minted', { who: ALICE, amount: '10000' }));
      mockLedger('4000');
      await handleBonded(tupleEvent('staking', 'Bonded', ['0xdid', ALICE, '4000'], 7_004_001));

      mockLedger('2500');
      await handleWithdrawn(tupleEvent('staking', 'Withdrawn', [ALICE, '1500'], 7_004_001));

      expect(balance(ALICE)?.frozen).toBe(BigInt(2500));
    });

    it('falls back to the delta accumulator when the ledger cannot be read', async () => {
      await handleBalanceMinted(balancesEvent('Minted', { who: ALICE, amount: '10000' }));
      (globalThis as any).api.query = {}; // no staking.ledger

      await handleBonded(tupleEvent('staking', 'Bonded', ['0xdid', ALICE, '4000'], 7_004_001));

      expect(balance(ALICE)?.frozen).toBe(BigInt(4000));
    });
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

/**
 * Defects found by review against the chain source and live v8 blocks, each of which the ledger
 * used to get wrong in a way no fixture reproduced.
 */
describe('v8 pairings the chain emits but the ledger double-counted', () => {
  it('F9: a fee is debited once, not twice (Withdraw then TransactionFeePaid)', async () => {
    const [withdraw, feePaid] = extrinsicEvents(2_000_100, [
      ['balances', 'Withdraw', { who: ALICE, amount: '500' }],
      ['transactionPayment', 'TransactionFeePaid', { who: ALICE, actualFee: '500', tip: '0' }],
    ]);

    await handleBalanceBurned(withdraw);
    await handleTransactionFeeCharged(feePaid);

    expect(balance(ALICE)?.free).toBe(BigInt(-500));
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ kind: MovementKind.Fee, amountAbs: BigInt(500) });
    expect(balance(ALICE)?.totalFeesPaid).toBe(BigInt(500));
  });

  it('F9: an over-estimated fee nets to the amount actually charged', async () => {
    // withdraw the 500 estimate, refund 200, charge 300
    const [withdraw, refund, feePaid] = extrinsicEvents(2_000_200, [
      ['balances', 'Withdraw', { who: ALICE, amount: '500' }],
      ['balances', 'Deposit', { who: ALICE, amount: '200' }],
      ['transactionPayment', 'TransactionFeePaid', { who: ALICE, actualFee: '300', tip: '0' }],
    ]);

    await handleBalanceBurned(withdraw);
    await handleBalanceMinted(refund);
    await handleTransactionFeeCharged(feePaid);

    expect(balance(ALICE)?.free).toBe(BigInt(-300));
    expect(balance(ALICE)?.totalFeesPaid).toBe(BigInt(300));
    expect(entries().every(r => r.kind === MovementKind.Fee)).toBe(true);
  });

  it('F9: a protocol fee on a runtime that emits no Withdraw still posts its own debit', async () => {
    await handleTransactionFeeCharged(
      structEvent(
        'protocolFee',
        'FeeCharged',
        { who: ALICE, amount: '250' },
        { specVersion: 7_000_000 }
      )
    );

    expect(balance(ALICE)?.free).toBe(BigInt(-250));
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ kind: MovementKind.Fee });
  });

  it('N2: an account created by a deposit is credited once (Deposit then Endowed)', async () => {
    const [deposit, endowed] = extrinsicEvents(2_000_300, [
      ['balances', 'Deposit', { who: BOB, amount: '1000' }],
      ['balances', 'Endowed', { who: BOB, amount: '1000' }],
    ]);

    await handleBalanceMinted(deposit);
    await handleBalanceEndowed(endowed);

    expect(balance(BOB)?.free).toBe(BigInt(1000));
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      kind: MovementKind.Endowment,
      direction: EntryDirection.Credit,
    });
  });

  it('F2: TransferAndHold moves the `transferred` amount, not 0', async () => {
    await handleTransferAndHold(
      balancesEvent('TransferAndHold', {
        reason: STAKING_HOLD_REASON,
        source: ALICE,
        dest: BOB,
        transferred: '750',
      })
    );

    expect(balance(ALICE)?.free).toBe(BigInt(-750));
    expect(balance(BOB)).toMatchObject({ reserved: BigInt(750), bonded: BigInt(750) });
  });

  it('F10: a v8 staking slash comes out of the Staking hold, not free', async () => {
    await handleBalanceHeld(
      balancesEvent('Held', { reason: STAKING_HOLD_REASON, who: ALICE, amount: '1000' })
    );
    await handleStakingSlash(structEvent('staking', 'Slashed', { staker: ALICE, amount: '400' }));

    expect(balance(ALICE)).toMatchObject({
      // only the hold moved free; the slash left it alone
      free: BigInt(-1000),
      reserved: BigInt(600),
      bonded: BigInt(600),
      totalSlashed: BigInt(400),
    });
    expect(balance(ALICE)?.holds).toEqual([{ reason: HoldReason.Staking, amount: BigInt(600) }]);
  });

  it('F3: two equal transfers to one new account both credit it', async () => {
    const [endowed, first, second] = extrinsicEvents(2_000_400, [
      ['balances', 'Endowed', { who: BOB, amount: '100' }],
      ['balances', 'Transfer', { from: ALICE, to: BOB, amount: '100' }],
      ['balances', 'Transfer', { from: ALICE, to: BOB, amount: '100' }],
    ]);

    await handleBalanceEndowed(endowed);
    await handleBalanceTransfer(first);
    await handleBalanceTransfer(second);

    expect(balance(BOB)?.free).toBe(BigInt(200));
    expect(balance(ALICE)?.free).toBe(BigInt(-200));
  });

  it('F11: a memo lands on both sides of its movement, and equal transfers keep their own', async () => {
    const [firstTransfer, firstMemo, secondTransfer, secondMemo] = extrinsicEvents(2_000_600, [
      ['balances', 'Transfer', { from: ALICE, to: BOB, amount: '10' }],
      ['balances', 'TransferWithMemo', { from: ALICE, to: BOB, amount: '10', memo: 'invoice-1' }],
      ['balances', 'Transfer', { from: ALICE, to: BOB, amount: '10' }],
      ['balances', 'TransferWithMemo', { from: ALICE, to: BOB, amount: '10', memo: 'invoice-2' }],
    ]);

    await handleBalanceTransfer(firstTransfer);
    await handleBalanceTransferWithMemo(firstMemo);
    await handleBalanceTransfer(secondTransfer);
    await handleBalanceTransferWithMemo(secondMemo);

    const memos = entries().map(r => r.memo);

    // both sides of both movements, each movement keeping its own memo
    expect(memos.filter(m => m === 'invoice-1')).toHaveLength(2);
    expect(memos.filter(m => m === 'invoice-2')).toHaveLength(2);
  });

  it('F11: a memo arriving before its Transfer is queued per movement, not overwritten', async () => {
    const [firstMemo, secondMemo, firstTransfer, secondTransfer] = extrinsicEvents(2_000_700, [
      ['balances', 'TransferWithMemo', { from: ALICE, to: BOB, amount: '10', memo: 'early-1' }],
      ['balances', 'TransferWithMemo', { from: ALICE, to: BOB, amount: '10', memo: 'early-2' }],
      ['balances', 'Transfer', { from: ALICE, to: BOB, amount: '10' }],
      ['balances', 'Transfer', { from: ALICE, to: BOB, amount: '10' }],
    ]);

    await handleBalanceTransferWithMemo(firstMemo);
    await handleBalanceTransferWithMemo(secondMemo);
    await handleBalanceTransfer(firstTransfer);
    await handleBalanceTransfer(secondTransfer);

    const memos = entries().map(r => r.memo);

    expect(memos.filter(m => m === 'early-1')).toHaveLength(2);
    expect(memos.filter(m => m === 'early-2')).toHaveLength(2);
  });

  it('a BalanceSet naming no account writes nothing, rather than an Account keyed undefined', async () => {
    // `ledgerAccount` creates and saves whatever id it is handed, so an undecodable `who` used to
    // produce a phantom Account/AccountBalance/PolyxEntry keyed `undefined`. strictNullChecks
    // flags this call; the runtime never did.
    await handleBalanceSet(balancesEvent('BalanceSet', { free: '5000' }));

    expect(db['Account']).toBeUndefined();
    expect(db['AccountBalance']).toBeUndefined();
    expect(entries()).toHaveLength(0);
    expect(Object.keys(db['IndexerAnomaly'] ?? {})).toHaveLength(1);
  });

  it('F12: relabelling an entry moves its lifetimeByKind totals with it', async () => {
    const [deposit, rewarded] = extrinsicEvents(2_000_500, [
      ['balances', 'Deposit', { who: ALICE, amount: '900' }],
      ['staking', 'Rewarded', { stash: ALICE, dest: 'Stash', amount: '900' }],
    ]);

    await handleBalanceMinted(deposit);
    await handleReward(rewarded);

    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ kind: MovementKind.StakingReward });
    expect(balance(ALICE)).toMatchObject({ free: BigInt(900), totalRewards: BigInt(900) });
    expect(balance(ALICE)?.lifetimeByKind).toEqual([
      { kind: MovementKind.StakingReward, totalAbs: BigInt(900), net: BigInt(900), count: 1 },
    ]);
  });
});
