/**
 * The POLYX ledger — one fixture per row of the "Event → pool transition" table in
 * docs/implementation/02-polyx-ledger.md, plus the properties the old `PolyxTransaction` model
 * could not satisfy: a `Reserved`/`Unreserved` round-trip returns the pools to their starting
 * values, and every movement writes a signed entry per account-side sharing one `movementId`.
 *
 * Events are built struct-style (v8), which is the surface that was once left entirely unindexed.
 */

import { SubstrateEvent } from '@subql/types';

jest.mock('../../src/utils/blockAuthor', () => ({ blockAuthor: jest.fn() }));
jest.mock('../../src/mappings/entities/identities/feePayer', () => ({
  resolveFeePayer: jest.fn(),
}));
import { resolveFeePayer } from '../../src/mappings/entities/identities/feePayer';
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
  handleBridgeMint,
  handlePayoutStarted,
  handleReward,
  handleWithdrawn,
  handleDustLost,
  handleIdentityGrant,
  handlePipsDeposit,
  handleProposalRefund,
  handleReserveRepatriated,
  handleStakingSlash,
  handleTransactionFeeCharged,
  handleTransferAndHold,
  handleTreasuryDisbursement,
  handleTreasuryReimbursement,
} from '../../src/mappings/entities/identities/mapPolyxLedger';
import { postUneventedTransactionFee } from '../../src/mappings/entities/identities/preV54Fees';
import { getAccountId, systematicIssuers } from '../../src/mappings/consts';
import { blockAuthor } from '../../src/utils/blockAuthor';
import { __resetStakingCaches } from '../../src/utils/staking';
import { __resetBlockContext } from '../../src/mappings/blockContext';
import {
  applyChainFreezes,
  emptyBalance,
} from '../../src/mappings/entities/identities/mapPolyxLedger';

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

const storeGet = (): jest.Mock => (globalThis as any).store.get as jest.Mock;
const storeSet = (): jest.Mock => (globalThis as any).store.set as jest.Mock;
const storeGetByFields = (): jest.Mock => (globalThis as any).store.getByFields as jest.Mock;

/**
 * `toString()` is `stringify(toJSON())` in polkadot-js, so a composite enum such as v8's
 * `RuntimeHoldReason` stringifies to `'{"staking":"Staking"}'`, not `'Staking'`. Mirroring that
 * here is what lets a fixture carry the shape the chain really emits — a plain string mock hid
 * the hold-reason defect entirely.
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
): SubstrateEvent[] => {
  const events = emitted.map(([section, method, fields], index) => {
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

  // The block's own event list, as the node hands it over — the fee paths read which events the
  // extrinsic emitted from it, rather than trusting the block's spec label.
  const records = events.map(event => ({
    phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => 1 } },
    event: (event as any).event,
  }));
  events.forEach(event => {
    (event as any).block.events = records;
  });

  return events;
};

/**
 * A run of pre-v8 tuple events from one extrinsic, in order, sharing a block — the pre-v8
 * counterpart of `extrinsicEvents`, for pairings that key on the block.
 */
const v7ExtrinsicEvents = (
  height: number,
  emitted: [section: string, method: string, values: string[]][],
  specVersion = 7_004_001
): SubstrateEvent[] =>
  emitted.map(([section, method, values], index) => {
    const event = tupleEvent(section, method, values, specVersion);

    (event as unknown as { block: { block: unknown } }).block.block = {
      header: { number: { toString: () => String(height) } },
    };
    (event as { idx: number }).idx = index;
    (event as { extrinsic?: unknown }).extrinsic = {
      idx: 1,
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
  __resetBlockContext();
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
  ((globalThis as any).store.getByField as jest.Mock).mockImplementation(
    (entity: string, field: string, value: unknown) =>
      Promise.resolve(
        Object.values(db[entity] ?? {})
          .filter(row => row[field] === value)
          .map(clone)
      )
  );

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
    // `{ staking: 'Staking' }` stringifies to `'{"staking":"Staking"}'`, which matched no
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

  it('credits a new account once when a transfer outside any extrinsic creates it', async () => {
    // Testnet block 10,036,148 (spec 6000001): scheduled settlement instructions ran as the block
    // initialised, each paying a new account: `Endowed` then `Transfer`, adjacent. Paired only
    // within an extrinsic, each of the 29 recipients was credited twice.
    const NEW_ACCOUNT = '5HCBK1bGMAcJNYmm1zE1MTkiYD4gFezfLewc3rEjj1FmigyE';
    const events = v7ExtrinsicEvents(
      10_036_148,
      [
        ['balances', 'Endowed', ['0x00', NEW_ACCOUNT, '210000']],
        ['balances', 'Transfer', ['0x9c8f', ALICE, '0x00', NEW_ACCOUNT, '210000']],
        // a later, unrelated transfer of the same amount to the account, once it exists
        ['balances', 'Transfer', ['0x9c8f', BOB, '0x00', NEW_ACCOUNT, '210000']],
      ],
      6_000_001
    );
    events.forEach(event => delete (event as { extrinsic?: unknown }).extrinsic);

    await handleBalanceEndowed(events[0]);
    await handleBalanceTransfer(events[1]);
    await handleBalanceTransfer(events[2]);

    expect(balance(NEW_ACCOUNT)?.free).toBe(BigInt(420_000));
    expect(balance(ALICE)?.free).toBe(BigInt(-210_000));
    expect(balance(BOB)?.free).toBe(BigInt(-210_000));
  });

  it('pairs each 5.x disbursement with the transfer just before it, outside any extrinsic', async () => {
    // Testnet block 6,527,686 (spec 5001020): PIP 26, enacted as the block initialised, paid 11 × 1
    // unit, each as `balances.Transfer{treasury → recipient}` then `TreasuryDisbursement`. Matched
    // only within an extrinsic, every one was counted twice: recipient +11, treasury −11.
    const committeeDid = '0x73797374656d3a676f7665726e616e63655f636f6d6d69747465650000000000';
    const recipientDid = '0x8015a1702789fedf8474a042af07ba6a37f94e8d24b4eed89414e6eb79df084e';
    const treasury = getAccountId(systematicIssuers.treasury.accountId, 42);
    const treasuryDid = '0x73797374656d3a74726561737572795f6d6f64756c655f646964000000000000';

    const pair = (): [string, string, string[]][] => [
      ['balances', 'Transfer', [treasuryDid, treasury, recipientDid, BOB, '1']],
      ['treasury', 'TreasuryDisbursement', [committeeDid, recipientDid, BOB, '1']],
    ];
    const events = v7ExtrinsicEvents(6_527_686, [...pair(), ...pair(), ...pair()], 5_001_020);
    events.forEach(event => delete (event as { extrinsic?: unknown }).extrinsic);

    for (const event of events) {
      await (event.event.method === 'Transfer'
        ? handleBalanceTransfer(event)
        : handleTreasuryDisbursement(event));
    }

    expect(balance(BOB)?.free).toBe(BigInt(3));
    expect(balance(treasury)?.free).toBe(BigInt(-3));
    expect(entries()).toHaveLength(6);
    expect(entries().every(r => r.kind === MovementKind.TreasuryDisbursement)).toBe(true);
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

describe('staking — era-dependent, inverted at v8', () => {
  const stakingLedgerOf = (total: string) => ({
    staking: {
      bonded: jest.fn().mockResolvedValue({ toJSON: () => null }),
      ledger: jest.fn().mockResolvedValue({ toJSON: () => ({ total, active: total }) }),
    },
  });

  it('v7 Bonded produces no PolyxEntry and raises frozen via the staking lock', async () => {
    await handleBalanceMinted(balancesEvent('Minted', { who: ALICE, amount: '10000' }));
    const beforeEntries = entries().length;
    (globalThis as any).api.query = stakingLedgerOf('4000');

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
    (globalThis as any).api.query = stakingLedgerOf('4000');
    await handleBonded(tupleEvent('staking', 'Bonded', ['0xdid', ALICE, '4000'], 7_004_001));

    (globalThis as any).api.query = stakingLedgerOf('2500');
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

  it('pre-v8 Reward fails the block when the payee read fails, rather than crediting the stash', async () => {
    (globalThis as any).api.query = {
      staking: {
        payee: jest.fn().mockRejectedValue(new Error('WebSocket is not connected')),
        bonded: jest.fn().mockResolvedValue({ toJSON: () => null }),
      },
    };

    await expect(
      handleReward(tupleEvent('staking', 'Reward', ['0xdid', ALICE, '900'], 7_004_001))
    ).rejects.toThrow('WebSocket is not connected');
    expect(entries().find(r => r.kind === MovementKind.StakingReward)).toBeUndefined();

    (globalThis as any).api.query = {};
  });

  it('pre-v8 Reward with a Staked payee credits free AND raises the staking lock', async () => {
    (globalThis as any).api.query = {
      staking: {
        ...stakingLedgerOf('500').staking,
        payee: jest.fn().mockResolvedValue({ toJSON: () => 'Staked' }),
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

  describe('a deposit the block reward reserve funds, before v8', () => {
    // Pre-v8, dropping a deposit's positive imbalance takes what it can from the block reward
    // reserve and mints only the rest, with no event (testnet block 9,259,823 emptied it).
    const RESERVE = getAccountId(systematicIssuers.blockRewardReserve.accountId, 42);
    const NEW_PAYEE = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy';

    const fundReserve = (amount: string) =>
      handleBalanceEndowed(
        tupleEvent('balances', 'Endowed', ['0xbrr', RESERVE, amount], 7_004_001)
      );
    const payee = (to: unknown) => {
      (globalThis as any).api.query = {
        staking: {
          payee: jest.fn().mockResolvedValue({ toJSON: () => to }),
          bonded: jest.fn().mockResolvedValue({ toJSON: () => null }),
        },
      };
    };

    beforeEach(() => payee('Stash'));
    afterEach(() => {
      (globalThis as any).api.query = {};
    });

    it('pays a reward from the reserve while it holds enough', async () => {
      await fundReserve('1000');

      await handleReward(tupleEvent('staking', 'Reward', ['0xdid', ALICE, '300'], 7_004_001));

      expect(balance(RESERVE)?.free).toBe(BigInt(700));
      expect(balance(ALICE)?.free).toBe(BigInt(300));
      expect(balance(ALICE)?.totalRewards).toBe(BigInt(300));
      // the reserve paid a reward, it did not receive one
      expect(balance(RESERVE)?.totalRewards).toBe(BigInt(0));
      expect(entries().find(r => r.accountId === ALICE)).toMatchObject({
        kind: MovementKind.StakingReward,
        counterpartyAddress: RESERVE,
      });
    });

    it('pays what the reserve has and mints the rest', async () => {
      await fundReserve('100');

      await handleReward(tupleEvent('staking', 'Reward', ['0xdid', ALICE, '300'], 7_004_001));

      expect(balance(RESERVE)?.free).toBe(BigInt(0));
      expect(balance(ALICE)?.free).toBe(BigInt(300));
      const credits = entries().filter(r => r.accountId === ALICE);
      expect(credits.map(r => r.amount).sort()).toEqual([BigInt(100), BigInt(200)]);
      expect(new Set(credits.map(r => r.id)).size).toBe(2);
    });

    it('mints a reward the empty reserve cannot pay', async () => {
      await handleReward(tupleEvent('staking', 'Reward', ['0xdid', ALICE, '300'], 7_004_001));

      expect(balance(ALICE)?.free).toBe(BigInt(300));
      expect(balance(RESERVE)).toBeUndefined();
    });

    it('draws on the reserve for a reward whose payout created its payee', async () => {
      await fundReserve('1000');
      payee({ account: NEW_PAYEE });
      const [endowed, reward] = v7ExtrinsicEvents(
        9_259_823,
        [
          ['balances', 'Endowed', ['0xdid', NEW_PAYEE, '300']],
          ['staking', 'Reward', ['0xdid', ALICE, '300']],
        ],
        7_004_001
      );

      await handleBalanceEndowed(endowed);
      await handleReward(reward);

      expect(balance(NEW_PAYEE)?.free).toBe(BigInt(300));
      expect(balance(RESERVE)?.free).toBe(BigInt(700));
      expect(entries().find(r => r.accountId === NEW_PAYEE)).toMatchObject({
        kind: MovementKind.StakingReward,
        counterpartyAddress: RESERVE,
      });
      expect(entries().find(r => r.accountId === RESERVE && r.amount < 0)).toMatchObject({
        amount: BigInt(-300),
        counterpartyAddress: NEW_PAYEE,
      });
    });

    it("destroys the reserve's share of a pre-v5 treasury disbursement", async () => {
      // v4.1 `unsafe_disbursement` withdraws from the treasury, then deposits to the recipient:
      // the withdrawal is burned, and the deposit is funded like any other
      const treasury = getAccountId(systematicIssuers.treasury.accountId, 42);
      await fundReserve('1000');
      // the pre-5.0.0 event names the recipient's identity, paid through its primary key
      db['Identity'] = { '0xdid': { id: '0xdid', primaryAccount: BOB } };

      await handleTreasuryDisbursement(
        tupleEvent('treasury', 'TreasuryDisbursement', ['0xgc', '0xdid', '400'], 3010)
      );

      expect(balance(BOB)?.free).toBe(BigInt(400));
      expect(balance(treasury)?.free).toBe(BigInt(-400));
      expect(balance(RESERVE)?.free).toBe(BigInt(600));
      expect(entries().find(r => r.accountId === RESERVE && r.amount < 0)).toMatchObject({
        kind: MovementKind.Burn,
      });
    });
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

    it('fails the block when the ledger read fails, rather than moving the lock by the event', async () => {
      await handleBalanceMinted(balancesEvent('Minted', { who: ALICE, amount: '10000' }));
      (globalThis as any).api.query = {
        staking: {
          bonded: jest.fn().mockResolvedValue({ toJSON: () => null }),
          ledger: jest.fn().mockRejectedValue(new Error('WebSocket is not connected')),
        },
      };

      await expect(
        handleBonded(tupleEvent('staking', 'Bonded', ['0xdid', ALICE, '4000'], 7_004_001))
      ).rejects.toThrow('WebSocket is not connected');
      expect(balance(ALICE)?.frozen).toBe(BigInt(0));
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

  it('pairs a busy block without searching the store', async () => {
    // Every transfer, fee and deposit pairs with entries written earlier in its block. Searched in
    // the store, each lookup sorted every cached entry and sent their ids to Postgres: quadratic in
    // the block's size. The block's own index answers it instead.
    const rounds = Array.from({ length: 50 }, () => [
      ['balances', 'Withdraw', { who: ALICE, amount: '10' }],
      ['balances', 'Transfer', { from: ALICE, to: BOB, amount: '1' }],
      ['transactionPayment', 'TransactionFeePaid', { who: ALICE, actualFee: '10', tip: '0' }],
    ]).flat() as [string, string, Record<string, unknown>][];

    for (const event of extrinsicEvents(3_000_000, rounds)) {
      const handler = {
        Withdraw: handleBalanceBurned,
        Transfer: handleBalanceTransfer,
        TransactionFeePaid: handleTransactionFeeCharged,
      }[event.event.method as 'Withdraw' | 'Transfer' | 'TransactionFeePaid'];
      await handler(event);
    }

    const searched = storeGetByFields().mock.calls.filter(([entity]) => entity === 'PolyxEntry');
    expect(searched).toHaveLength(0);
    expect(balance(ALICE)?.free).toBe(BigInt(-550));
    expect(balance(ALICE)?.totalFeesPaid).toBe(BigInt(500));
  });

  it("posts no second debit for an Ethereum transaction's split gas charge", async () => {
    // Testnet block 24,913,217: the gas charge in two withdrawals, mostly refunded, and the fee the
    // difference; no single withdrawal accounts for it
    const events = extrinsicEvents(24_913_217, [
      ['balances', 'Withdraw', { who: ALICE, amount: '245926802' }],
      ['balances', 'Withdraw', { who: ALICE, amount: '54073198' }],
      ['balances', 'Deposit', { who: ALICE, amount: '299738595' }],
      ['transactionPayment', 'TransactionFeePaid', { who: ALICE, actualFee: '261405', tip: '0' }],
    ]);

    await handleBalanceBurned(events[0]);
    await handleBalanceBurned(events[1]);
    await handleBalanceMinted(events[2]);
    await handleTransactionFeeCharged(events[3]);

    expect(balance(ALICE)?.free).toBe(BigInt(-261_405));
  });

  it("posts no second debit when an Ethereum transaction's charge also pays contract deposits", async () => {
    // Testnet block 25,117,609: the withdrawals fund the code and storage deposits too, the call
    // burns 33, and the rest is refunded; the payer's entries already come to its real change
    const CONTRACT = '5HWbRf2kVZKH7d6Usr4XDVRPNcfqz6oJcnwGTvowdtpY7Em4';
    const events = extrinsicEvents(25_117_609, [
      ['balances', 'Withdraw', { who: ALICE, amount: '422519702' }],
      ['balances', 'Withdraw', { who: ALICE, amount: '54738898' }],
      ['balances', 'Deposit', { who: BOB, amount: '279780000' }],
      ['balances', 'Deposit', { who: CONTRACT, amount: '110791500' }],
      ['balances', 'Withdraw', { who: ALICE, amount: '33' }],
      ['balances', 'Deposit', { who: ALICE, amount: '85662633' }],
      ['transactionPayment', 'TransactionFeePaid', { who: ALICE, actualFee: '1024466', tip: '0' }],
    ]);

    for (const event of events) {
      const handler = {
        Withdraw: handleBalanceBurned,
        Deposit: handleBalanceMinted,
        TransactionFeePaid: handleTransactionFeeCharged,
      }[event.event.method as 'Withdraw' | 'Deposit' | 'TransactionFeePaid'];
      await handler(event);
    }

    expect(balance(ALICE)?.free).toBe(BigInt(-391_596_000));
  });

  it('charges a fee once when another withdrawal, returned, comes before the fee', async () => {
    // Testnet block 25,473,580: 3,132 withdrawn and deposited back around a relayer subsidy, and the
    // 155,668 fee withdrawn between them. Taking the first withdrawal for the fee's found 3,132,
    // smaller than the fee, and posted the fee a second time.
    const [first, feeWithdraw, returned, feePaid] = extrinsicEvents(25_473_580, [
      ['balances', 'Withdraw', { who: ALICE, amount: '3132' }],
      ['balances', 'Withdraw', { who: ALICE, amount: '155668' }],
      ['balances', 'Deposit', { who: ALICE, amount: '3132' }],
      ['transactionPayment', 'TransactionFeePaid', { who: ALICE, actualFee: '155668', tip: '0' }],
    ]);

    await handleBalanceBurned(first);
    await handleBalanceBurned(feeWithdraw);
    await handleBalanceMinted(returned);
    await handleTransactionFeeCharged(feePaid);

    expect(balance(ALICE)?.free).toBe(BigInt(-155_668));
    expect(balance(ALICE)?.totalFeesPaid).toBe(BigInt(155_668));
  });

  it('charges an Ethereum transaction its fee once, past the empty withdrawal before it', async () => {
    // Testnet block 25,118,132: `revive.eth_transact` withdraws nothing, then the 242,500 fee
    // estimate, then 71 the call burns; 44,371 is refunded and 198,129 charged. The empty
    // withdrawal was the payer's first burn, so it was taken for the fee's, failed the size check,
    // and the fee was posted a second time beside the real withdrawal and its refund.
    const [empty, feeWithdraw, callBurn, refund, feePaid] = extrinsicEvents(25_118_132, [
      ['balances', 'Withdraw', { who: ALICE, amount: '0' }],
      ['balances', 'Withdraw', { who: ALICE, amount: '242500' }],
      ['balances', 'Withdraw', { who: ALICE, amount: '71' }],
      ['balances', 'Deposit', { who: ALICE, amount: '44371' }],
      ['transactionPayment', 'TransactionFeePaid', { who: ALICE, actualFee: '198129', tip: '0' }],
    ]);

    await handleBalanceBurned(empty);
    await handleBalanceBurned(feeWithdraw);
    await handleBalanceBurned(callBurn);
    await handleBalanceMinted(refund);
    await handleTransactionFeeCharged(feePaid);

    expect(balance(ALICE)?.free).toBe(BigInt(-198_200));
    expect(balance(ALICE)?.totalFeesPaid).toBe(BigInt(198_129));
    // a movement of nothing writes nothing
    expect(entries().some(r => r.amount === BigInt(0))).toBe(false);
  });

  /**
   * The fee withdrawal is found by where it sits, not by its size. Here the estimate (600) is refunded
   * down to 500, and the call itself also burns exactly 500 — matching on amount re-filed the call's
   * burn as the fee and left the real withdrawal counted as a burn.
   */
  it('re-files the withdrawal taken before the call, not a burn of the same size made by the call', async () => {
    const [feeWithdraw, callBurn, refund, feePaid] = extrinsicEvents(2_000_300, [
      ['balances', 'Withdraw', { who: ALICE, amount: '600' }],
      ['balances', 'Withdraw', { who: ALICE, amount: '500' }],
      ['balances', 'Deposit', { who: ALICE, amount: '100' }],
      ['transactionPayment', 'TransactionFeePaid', { who: ALICE, actualFee: '500', tip: '0' }],
    ]);

    await handleBalanceBurned(feeWithdraw);
    await handleBalanceBurned(callBurn);
    await handleBalanceMinted(refund);
    await handleTransactionFeeCharged(feePaid);

    const byAmount = (amount: number) => entries().find(r => r.amountAbs === BigInt(amount));
    expect(byAmount(600)?.kind).toBe(MovementKind.Fee);
    expect(byAmount(100)?.kind).toBe(MovementKind.Fee);
    expect(byAmount(500)?.kind).toBe(MovementKind.Burn);
    expect(balance(ALICE)?.totalFeesPaid).toBe(BigInt(500));
    // every POLYX that left still left exactly once
    expect(balance(ALICE)?.free).toBe(BigInt(-1000));
  });

  it('does not look for a withdrawal on a runtime that never pairs one with a fee', async () => {
    // inside an extrinsic, as every fee is — an event with none would skip the lookup anyway
    const [feePaid] = extrinsicEvents(
      2_000_400,
      [['transactionPayment', 'TransactionFeePaid', { who: ALICE, actualFee: '250', tip: '0' }]],
      { specVersion: 7_000_000 }
    );

    await handleTransactionFeeCharged(feePaid);

    const lookedForBurns = storeGetByFields().mock.calls.some(
      ([entity, filter]: [string, [string, string, unknown][]]) =>
        entity === 'PolyxEntry' && filter.some(([field]) => field === 'extrinsicId')
    );
    expect(lookedForBurns).toBe(false);
    expect(entries()[0]).toMatchObject({ kind: MovementKind.Fee, amountAbs: BigInt(250) });
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

  describe('a subsidised fee', () => {
    const PAYER = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy';

    beforeEach(() => {
      // the signer pays, as for every call but a few (see feePayer.test.ts)
      (resolveFeePayer as jest.Mock).mockImplementation((extrinsic: any) =>
        Promise.resolve(extrinsic.extrinsic.signer.toString())
      );
      db['Subsidy'] = {
        [`${ALICE}/${PAYER}`]: {
          id: `${ALICE}/${PAYER}`,
          beneficiaryAccountId: ALICE,
          payingAccountId: PAYER,
          isAccepted: true,
          isRemoved: false,
        },
      };
    });

    it('pre-v8: a protocol fee is debited from the paying key, not the user', async () => {
      await handleTransactionFeeCharged(
        structEvent(
          'protocolFee',
          'FeeCharged',
          { who: ALICE, amount: '2500' },
          { specVersion: 5_003_001 }
        )
      );

      expect(balance(ALICE)).toBeUndefined();
      expect(balance(PAYER)?.free).toBe(BigInt(-2500));
    });

    /** A `TransactionFeePaid` naming `who`, closing a call `signer` signed. */
    const feePaidIn = (
      section: string,
      {
        method = 'anything',
        signer = ALICE,
        who = signer,
        specVersion = 5_004_000,
      }: {
        method?: string;
        signer?: string;
        who?: string;
        specVersion?: number;
      } = {}
    ) => {
      const event = structEvent(
        'transactionPayment',
        'TransactionFeePaid',
        { who, actualFee: '7', tip: '0' },
        { specVersion }
      );
      (event as { extrinsic?: unknown }).extrinsic = {
        idx: 1,
        extrinsic: {
          method: { section, method },
          signer: { toString: () => signer },
        },
        success: true,
      };
      return event;
    };

    it('v5.4.0: a transaction fee goes to the paying key for any call but the relayer', async () => {
      await handleTransactionFeeCharged(feePaidIn('asset'));

      expect(balance(ALICE)).toBeUndefined();
      expect(balance(PAYER)?.free).toBe(BigInt(-7));
    });

    it('v5.4.0: the user pays for its own relayer call', async () => {
      await handleTransactionFeeCharged(feePaidIn('relayer'));

      expect(balance(ALICE)?.free).toBe(BigInt(-7));
      expect(balance(PAYER)).toBeUndefined();
    });

    describe('a call someone else pays for', () => {
      // Testnet block 8,524,136 (spec 5004000): `relayer.accept_paying_key` signed by 5Ckx2…, whose
      // balance did not move. `TransactionFeePaid` named the signer, but the runtime charged the
      // primary key of the identity that issued the authorization, as before v5.4.
      const SIGNER = '5HCBK1bGMAcJNYmm1zE1MTkiYD4gFezfLewc3rEjj1FmigyE';

      /** The runtime's payer for the call: the authorization issuer's primary key, `primaryKey`. */
      const issuedBy = (primaryKey: string) =>
        (resolveFeePayer as jest.Mock).mockResolvedValue(primaryKey);
      const acceptPayingKey = (opts: { who?: string; specVersion?: number } = {}) =>
        feePaidIn('relayer', { method: 'acceptPayingKey', signer: SIGNER, ...opts });

      it('v5.4.0: charges the account the runtime charged, not the signer the event names', async () => {
        issuedBy(BOB);

        await handleTransactionFeeCharged(acceptPayingKey());

        expect(balance(SIGNER)).toBeUndefined();
        expect(balance(BOB)?.free).toBe(BigInt(-7));
      });

      it("v5.4.0: applies the payer's subsidy, not the signer's", async () => {
        // ALICE, the issuer's primary key, is subsidised by PAYER
        issuedBy(ALICE);

        await handleTransactionFeeCharged(
          feePaidIn('identity', { method: 'joinIdentityAsKey', signer: SIGNER })
        );

        expect(balance(SIGNER)).toBeUndefined();
        expect(balance(ALICE)).toBeUndefined();
        expect(balance(PAYER)?.free).toBe(BigInt(-7));
      });

      it('from v5.4.1: charges whoever the event names, which is the account charged', async () => {
        // checked on testnet at 5004002, 6002010, 7000005 and 7003003: the named account's balance
        // fell by the fee and the signer's did not
        issuedBy(ALICE);

        await handleTransactionFeeCharged(acceptPayingKey({ who: BOB, specVersion: 6_002_010 }));

        expect(balance(BOB)?.free).toBe(BigInt(-7));
        expect(balance(ALICE)).toBeUndefined();
        expect(balance(PAYER)).toBeUndefined();
      });
    });

    it('from v5.4.1: charges a protocol fee to whoever the event names, already subsidised', async () => {
      // Testnet block 14,872,581 (v6.3): `asset.register_ticker` by a user PAYER subsidises, and
      // PAYER itself subsidised by BOB. `FeeCharged` named PAYER, who paid; applying the subsidy
      // again moved the 25 POLYX on to BOB.
      db['Subsidy'][`${PAYER}/${BOB}`] = {
        id: `${PAYER}/${BOB}`,
        beneficiaryAccountId: PAYER,
        payingAccountId: BOB,
        isAccepted: true,
        isRemoved: false,
      };

      await handleTransactionFeeCharged(
        structEvent(
          'protocolFee',
          'FeeCharged',
          { who: PAYER, amount: '25000000' },
          { specVersion: 6_003_030 }
        )
      );

      expect(balance(PAYER)?.free).toBe(BigInt(-25_000_000));
      expect(balance(BOB)).toBeUndefined();
    });

    it('from v5.4.1: does not redirect a fee the event already places', async () => {
      // the subsidy was already applied by the runtime when it chose whom to name
      await handleTransactionFeeCharged(feePaidIn('asset', { specVersion: 6_002_010 }));

      expect(balance(ALICE)?.free).toBe(BigInt(-7));
      expect(balance(PAYER)).toBeUndefined();
    });

    it("v8: re-files the paying key's Withdraw, which the fee event names", async () => {
      // v8 withdraws a subsidised fee from the paying key and names it in `TransactionFeePaid`
      // (`fee_key`, transaction-payment v8.0.0 and v8.1.2), so the event's account is the one whose
      // withdrawal to pair, and the user is never touched
      const [withdraw, feePaid] = extrinsicEvents(2_000_150, [
        ['balances', 'Withdraw', { who: PAYER, amount: '500' }],
        ['transactionPayment', 'TransactionFeePaid', { who: PAYER, actualFee: '500', tip: '0' }],
      ]);

      await handleBalanceBurned(withdraw);
      await handleTransactionFeeCharged(feePaid);

      expect(balance(ALICE)).toBeUndefined();
      expect(balance(PAYER)?.free).toBe(BigInt(-500));
      expect(entries()).toHaveLength(1);
      expect(entries()[0]).toMatchObject({ kind: MovementKind.Fee, accountId: PAYER });
      // and no subsidy lookup: from v5.4.1 the event already names the account charged
      const getByField = (globalThis as any).store.getByField as jest.Mock;
      expect(getByField.mock.calls.some(([entity]) => entity === 'Subsidy')).toBe(false);
    });

    it('ignores a subsidy that was removed', async () => {
      db['Subsidy'][`${ALICE}/${PAYER}`].isRemoved = true;

      await handleTransactionFeeCharged(
        structEvent(
          'protocolFee',
          'FeeCharged',
          { who: ALICE, amount: '3' },
          { specVersion: 5_003_001 }
        )
      );

      expect(balance(ALICE)?.free).toBe(BigInt(-3));
    });
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

/**
 * Event orderings taken from the runtime source rather than assumed — `pallets/balances` and
 * `pallets/staking` at Polymesh v7.4.0, and `substrate/frame/{balances,staking}` at the
 * `polkadot-sdk` commit the chain pins (`f4d81a0`).
 */
describe('pairings in the order the runtime actually emits them', () => {
  const NEW_PAYEE = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy';

  const payeeIs = (payee: unknown) => {
    (globalThis as any).api.query = {
      staking: {
        payee: jest.fn().mockResolvedValue({ toJSON: () => payee }),
        bonded: jest.fn().mockResolvedValue({ toJSON: () => null }),
      },
    };
  };

  afterEach(() => {
    (globalThis as any).api.query = {};
  });

  it('pre-v8: a reward that creates its destination is credited once (Endowed, then Rewarded)', async () => {
    // `deposit_creating` emits only `Endowed` — Polymesh's pallet never had a `Deposit` event —
    // and `make_payout` returns before `Rewarded` is deposited.
    payeeIs({ account: NEW_PAYEE });
    const [endowed, rewarded] = v7ExtrinsicEvents(3_000_100, [
      ['balances', 'Endowed', ['0xdid', NEW_PAYEE, '900']],
      ['staking', 'Rewarded', ['0xdid', ALICE, '900']],
    ]);

    await handleBalanceEndowed(endowed);
    await handleReward(rewarded);

    expect(balance(NEW_PAYEE)).toMatchObject({ free: BigInt(900), totalRewards: BigInt(900) });
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ kind: MovementKind.StakingReward });
  });

  it('v8: a reward that creates its destination is credited once (Endowed, Deposit, Rewarded)', async () => {
    // `mint_creating` → `fungible::Balanced::deposit`: `increase_balance` emits `Endowed`, then
    // `done_deposit` emits `Deposit`, and only then does `do_payout_stakers` emit `Rewarded`.
    const [endowed, deposit, rewarded] = extrinsicEvents(3_000_200, [
      ['balances', 'Endowed', { account: NEW_PAYEE, freeBalance: '900' }],
      ['balances', 'Deposit', { who: NEW_PAYEE, amount: '900' }],
      ['staking', 'Rewarded', { stash: ALICE, dest: { account: NEW_PAYEE }, amount: '900' }],
    ]);

    await handleBalanceEndowed(endowed);
    await handleBalanceMinted(deposit);
    await handleReward(rewarded);

    expect(balance(NEW_PAYEE)).toMatchObject({ free: BigInt(900), totalRewards: BigInt(900) });
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ kind: MovementKind.StakingReward });
  });

  it('v8: two equal rewards to one recipient in a block are two credits, not three', async () => {
    const events = extrinsicEvents(3_000_300, [
      ['balances', 'Deposit', { who: ALICE, amount: '250' }],
      ['staking', 'Rewarded', { stash: ALICE, dest: 'Stash', amount: '250' }],
      ['balances', 'Deposit', { who: ALICE, amount: '250' }],
      ['staking', 'Rewarded', { stash: ALICE, dest: 'Stash', amount: '250' }],
    ]);

    await handleBalanceMinted(events[0]);
    await handleReward(events[1]);
    await handleBalanceMinted(events[2]);
    await handleReward(events[3]);

    expect(balance(ALICE)?.free).toBe(BigInt(500));
    expect(entries().filter(r => r.kind === MovementKind.StakingReward)).toHaveLength(2);
  });

  it('v8: a Deposit only dedupes against an Endowed immediately before it', async () => {
    // an account created early in the block, then a separate deposit of the same size later —
    // two real credits, which a block-wide match would have collapsed into one
    const [endowed, unrelated, deposit] = extrinsicEvents(3_000_400, [
      ['balances', 'Endowed', { account: BOB, freeBalance: '100' }],
      ['balances', 'Reserved', { who: ALICE, amount: '1' }],
      ['balances', 'Deposit', { who: BOB, amount: '100' }],
    ]);

    await handleBalanceEndowed(endowed);
    await handleBalanceReserved(unrelated);
    await handleBalanceMinted(deposit);

    expect(balance(BOB)?.free).toBe(BigInt(200));
  });

  it('pre-v8: a memo-less transfer does not inherit the memo of an identical one before it', async () => {
    // `transfer_core` emits `TransferWithMemo` then `Transfer`, and `Transfer` repeats the memo,
    // so the stashed copy used to be left behind for the next matching transfer to pick up.
    const events = v7ExtrinsicEvents(3_000_500, [
      ['balances', 'TransferWithMemo', [ALICE, BOB, '10', 'rent']],
      ['balances', 'Transfer', ['0xa', ALICE, '0xb', BOB, '10', 'rent']],
      ['balances', 'Transfer', ['0xa', ALICE, '0xb', BOB, '10']],
    ]);

    await handleBalanceTransferWithMemo(events[0]);
    await handleBalanceTransfer(events[1]);
    await handleBalanceTransfer(events[2]);

    const byMovement = (idx: number) =>
      entries().filter(r => r.movementId === `0003000500/${String(idx).padStart(10, '0')}`);

    expect(byMovement(1).every(r => r.memo === 'rent')).toBe(true);
    expect(byMovement(2).some(r => r.memo === 'rent')).toBe(false);
  });
});

/**
 * `identity.do_register_did` gives the new primary key `InitialPOLYX` through `deposit_creating`,
 * then emits `DidCreated`. Pre-v8 Polymesh's balances pallet emitted nothing for a deposit — only
 * `Endowed` for a new account — so a key that already held POLYX got its grant silently. A testnet
 * resync found an account exactly 100,000 POLYX short this way.
 */
describe('the identity registration grant', () => {
  const GRANT = '100000000000';
  const DID = '0x248422a4cc2fc0384d7808c4790d41b76723f3b90e78083956b6b1532bf205f7';

  const initialPolyxIs = (value: string | undefined) => {
    (globalThis as any).api.consts =
      value === undefined ? {} : { identity: { initialPOLYX: value } };
  };

  afterEach(() => {
    (globalThis as any).api.consts = undefined;
  });

  it('pre-v8: credits the grant to a primary key that already existed', async () => {
    initialPolyxIs(GRANT);
    const [didCreated] = v7ExtrinsicEvents(3_100_100, [
      ['identity', 'DidCreated', [DID, ALICE, '[]']],
    ]);

    await handleIdentityGrant(didCreated);

    expect(balance(ALICE)?.free).toBe(BigInt(GRANT));
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      kind: MovementKind.Mint,
      direction: EntryDirection.Credit,
    });
  });

  it('pre-v8: does not credit a child identity, which gets no grant', async () => {
    initialPolyxIs(GRANT);
    const parentDid = jest.fn().mockResolvedValue({ isSome: true });
    (globalThis as any).api.query = { identity: { parentDid } };
    const [didCreated] = v7ExtrinsicEvents(3_100_150, [
      ['identity', 'DidCreated', [DID, ALICE, '[]']],
    ]);

    await handleIdentityGrant(didCreated);

    expect(parentDid).toHaveBeenCalledWith(DID);
    expect(balance(ALICE)).toBeUndefined();
    expect(entries()).toHaveLength(0);
  });

  it('pre-v8: does not credit it twice for a new key, whose Endowed already did', async () => {
    initialPolyxIs(GRANT);
    const [endowed, didCreated] = v7ExtrinsicEvents(3_100_200, [
      ['balances', 'Endowed', ['0xdid', ALICE, GRANT]],
      ['identity', 'DidCreated', [DID, ALICE, '[]']],
    ]);

    await handleBalanceEndowed(endowed);
    await handleIdentityGrant(didCreated);

    expect(balance(ALICE)?.free).toBe(BigInt(GRANT));
    expect(entries()).toHaveLength(1);
  });

  it('does nothing on v8, where the grant already arrives as a Deposit', async () => {
    initialPolyxIs(GRANT);

    await handleIdentityGrant(
      structEvent('identity', 'DidCreated', { did: DID, primaryKey: ALICE, secondaryKeys: [] })
    );

    expect(entries()).toHaveLength(0);
  });

  it('does nothing where the runtime grants nothing, as on mainnet', async () => {
    initialPolyxIs('0');
    const [didCreated] = v7ExtrinsicEvents(3_100_300, [
      ['identity', 'DidCreated', [DID, ALICE, '[]']],
    ]);

    await handleIdentityGrant(didCreated);

    expect(entries()).toHaveLength(0);
  });

  it('does nothing when the constant cannot be read', async () => {
    initialPolyxIs(undefined);
    const [didCreated] = v7ExtrinsicEvents(3_100_400, [
      ['identity', 'DidCreated', [DID, ALICE, '[]']],
    ]);

    await handleIdentityGrant(didCreated);

    expect(entries()).toHaveLength(0);
  });
});

/**
 * v8 `make_payout` still pays the deprecated `Controller` payee — to `bonded(stash)`, not the
 * stash. As a unit variant it decodes to a bare string, which the old object-only check sent to
 * the stash, leaving it high and the controller low by the reward total.
 */
describe('v8 reward destinations', () => {
  const CONTROLLER = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy';

  const bondedTo = (controller: string | null) => {
    (globalThis as any).api.query = {
      staking: { bonded: jest.fn().mockResolvedValue({ toJSON: () => controller }) },
    };
  };

  afterEach(() => {
    (globalThis as any).api.query = {};
  });

  it('credits a Controller payee to the controller, not the stash', async () => {
    bondedTo(CONTROLLER);

    await handleReward(
      structEvent('staking', 'Rewarded', { stash: ALICE, dest: 'Controller', amount: '250' })
    );

    expect(balance(CONTROLLER)?.free).toBe(BigInt(250));
    expect(balance(ALICE)).toBeUndefined();
  });

  it('falls back to the stash when the controller cannot be resolved', async () => {
    bondedTo(null);

    await handleReward(
      structEvent('staking', 'Rewarded', { stash: ALICE, dest: 'Controller', amount: '250' })
    );

    expect(balance(ALICE)?.free).toBe(BigInt(250));
  });

  it('fails the block when the controller read fails, rather than crediting the stash', async () => {
    (globalThis as any).api.query = {
      staking: { bonded: jest.fn().mockRejectedValue(new Error('WebSocket is not connected')) },
    };

    await expect(
      handleReward(
        structEvent('staking', 'Rewarded', { stash: ALICE, dest: 'Controller', amount: '250' })
      )
    ).rejects.toThrow('WebSocket is not connected');
    expect(balance(ALICE)).toBeUndefined();
  });

  it('still credits Stash and Staked payees to the stash, and Account to the named account', async () => {
    bondedTo(CONTROLLER);

    await handleReward(
      structEvent('staking', 'Rewarded', { stash: ALICE, dest: 'Stash', amount: '1' })
    );
    await handleReward(
      structEvent('staking', 'Rewarded', { stash: ALICE, dest: { staked: null }, amount: '2' })
    );
    await handleReward(
      structEvent('staking', 'Rewarded', { stash: ALICE, dest: { account: BOB }, amount: '4' })
    );

    expect(balance(ALICE)?.free).toBe(BigInt(3));
    expect(balance(BOB)?.free).toBe(BigInt(4));
    expect(balance(CONTROLLER)).toBeUndefined();
  });
});

/**
 * The pips pallet locks proposal and vote deposits under `'pips    '` with no balance event before
 * v8. A testnet resync found accounts at `frozen` 0 against exactly the 2,000 POLYX minimum
 * proposal deposit on chain.
 */
describe('pre-v8 PIPs deposit locks', () => {
  const ALICE_KEY = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';
  const PIPS = '0x7069707320202020'; // b"pips    "
  const STAKING = '0x7374616b696e6720'; // b"staking "

  const chainLocks = (byAccount: Record<string, { id: string; amount: string }[]>) => {
    const locks = jest.fn((address: string) =>
      Promise.resolve({ toJSON: () => byAccount[address] ?? [] })
    );
    (globalThis as any).api.query = { balances: { locks } };
    return locks;
  };

  const pipsLock = (address: string) =>
    balance(address)?.locks?.find((l: any) => l.lockId === 'pips    ')?.amount;

  it("Voted sets the voter's pips lock from chain", async () => {
    chainLocks({ [ALICE]: [{ id: PIPS, amount: '2000' }] });

    await handlePipsDeposit(
      tupleEvent('pips', 'Voted', ['0xdid', ALICE, '7', 'true', '2000'], 3000)
    );

    expect(pipsLock(ALICE)).toBe(BigInt(2000));
    expect(balance(ALICE)).toMatchObject({ frozen: BigInt(2000), bonded: BigInt(0) });
  });

  it('ProposalCreated locks a community proposer and skips a committee one', async () => {
    const locks = chainLocks({ [ALICE]: [{ id: PIPS, amount: '5000' }] });
    const created = (proposer: unknown) => {
      const event = tupleEvent('pips', 'ProposalCreated', ['0xdid', 'x', '1', '5000'], 3000);
      (event.event.data as any)[1] = {
        toString: () => JSON.stringify(proposer),
        registry: { chainSS58: 42 },
      };
      return event;
    };

    await handlePipsDeposit(created({ committee: { technical: null } }));
    expect(locks).not.toHaveBeenCalled();

    await handlePipsDeposit(created({ community: ALICE }));
    expect(pipsLock(ALICE)).toBe(BigInt(5000));
  });

  it('ProposalRefund re-reads the proposer and every voter', async () => {
    db['Proposal'] = {
      '0000000007': { id: '0000000007', proposer: { type: 'Community', value: BOB } },
    };
    db['ProposalVote'] = {
      [`0000000007/${ALICE_KEY}`]: { id: 'v', proposalId: '0000000007', account: ALICE_KEY },
    };
    chainLocks({
      [ALICE]: [{ id: PIPS, amount: '100' }],
      [BOB]: [{ id: PIPS, amount: '2000' }],
    });
    await handlePipsDeposit(
      tupleEvent('pips', 'Voted', ['0xdid', ALICE, '7', 'true', '100'], 3000)
    );
    await handlePipsDeposit(tupleEvent('pips', 'Voted', ['0xdid', BOB, '7', 'true', '2000'], 3000));

    chainLocks({ [ALICE]: [{ id: STAKING, amount: '50' }], [BOB]: [] });
    await handleProposalRefund(tupleEvent('pips', 'ProposalRefund', ['0xdid', '7', '2100'], 3000));

    expect(pipsLock(ALICE)).toBeUndefined();
    expect(pipsLock(BOB)).toBeUndefined();
    expect(balance(BOB)?.frozen).toBe(BigInt(0));
  });

  it('does nothing on v8, where balances.Locked/Unlocked carry the change', async () => {
    const locks = chainLocks({ [ALICE]: [{ id: PIPS, amount: '2000' }] });

    await handlePipsDeposit(
      structEvent('pips', 'Voted', {
        did: '0xdid',
        voter: ALICE,
        pipId: '7',
        aye: true,
        deposit: '2000',
      })
    );
    await handleProposalRefund(
      structEvent('pips', 'ProposalRefund', { did: '0xdid', pipId: '7', amount: '2000' })
    );

    expect(locks).not.toHaveBeenCalled();
    expect(balance(ALICE)).toBeUndefined();
  });

  it('a drift correction keeps the pips lock by id instead of filing it as residual', () => {
    const row = emptyBalance(ALICE, undefined, '0000000001') as any;

    applyChainFreezes(row, {
      frozen: BigInt(2000),
      stakingLock: BigInt(3),
      pipsLock: BigInt(2000),
    });

    expect(row.locks).toEqual([
      { lockId: 'staking ', amount: BigInt(3), reasons: 'staking' },
      { lockId: 'pips    ', amount: BigInt(2000), reasons: 'pips' },
    ]);
    expect(row.frozen).toBe(BigInt(2000));
    expect(row.bonded).toBe(BigInt(3));
  });
});

/**
 * The pre-v7 bridge credits its recipient through `deposit_creating`, which the pre-v8 balances
 * pallet reports only when it creates the account.
 */
describe('pre-v7 bridge mints', () => {
  const ALICE_KEY = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';
  const bridged = (height: number, idx: number, amount: string) => {
    const [event] = v7ExtrinsicEvents(
      height,
      [
        [
          'bridge',
          'Bridged',
          ['0xdid', JSON.stringify({ nonce: 1, recipient: ALICE_KEY, amount })],
        ],
      ],
      3010
    );
    (event.event.data as any)[1] = {
      toJSON: () => ({ nonce: 1, recipient: ALICE_KEY, amount: Number(amount), tx_hash: '0x1' }),
    };
    (event as { idx: number }).idx = idx;
    (event as { extrinsic?: unknown }).extrinsic = undefined;
    return event;
  };

  it('credits an existing recipient, whose deposit had no balance event', async () => {
    await handleBridgeMint(bridged(3_477_869, 1, '30000000000'));

    expect(balance(ALICE)?.free).toBe(BigInt(30_000_000_000));
    expect(entries()[0]).toMatchObject({ kind: MovementKind.Mint, accountId: ALICE });
  });

  it('writes nothing for the reserve endowed with nothing', async () => {
    // Pre-v8 every dropped positive imbalance touches the block reward reserve, which, empty, is
    // recreated with `Endowed(brr, 0)`: 210,000 of them on a testnet resync, each writing an entry
    // and a new balance version (27,000 for the reserve alone) that moved nothing.
    await handleBalanceEndowed(
      v7ExtrinsicEvents(3_000_000, [['balances', 'Endowed', ['0xbrr', BOB, '0']]], 3010)[0]
    );

    expect(entries()).toHaveLength(0);
    expect(balance(BOB)).toBeUndefined();
  });

  it('does not credit a new recipient twice, past the reserve endowment in between', async () => {
    const [endowed, brr] = v7ExtrinsicEvents(
      3_000_000,
      [
        ['balances', 'Endowed', ['0xdid', ALICE, '500']],
        ['balances', 'Endowed', ['0xbrr', BOB, '0']],
      ],
      3010
    );
    await handleBalanceEndowed(endowed);
    await handleBalanceEndowed(brr);

    await handleBridgeMint(bridged(3_000_000, 2, '500'));

    expect(balance(ALICE)?.free).toBe(BigInt(500));
    expect(entries().filter(r => r.accountId === ALICE)).toHaveLength(1);
  });

  it('is skipped on v8', async () => {
    const event = bridged(3_000_001, 1, '5');
    (event.block as any).specVersion = 8_000_000;

    await handleBridgeMint(event);

    expect(balance(ALICE)).toBeUndefined();
  });
});

/**
 * Every Polymesh runtime pays transaction and protocol fees to the block author. Before v8 it did so
 * with no event, so each fee left the payer and arrived nowhere — the reconciler saw validators
 * holding more than the index said, hundreds of times over a replay. On v8 the author's `Deposit`
 * records it, and was being filed as new POLYX.
 */
describe('the block author is paid the fee', () => {
  const AUTHOR = '5HCBK1bGMAcJNYmm1zE1MTkiYD4gFezfLewc3rEjj1FmigyE';

  it('before v8: credits the author with what the payer was charged', async () => {
    (blockAuthor as jest.Mock).mockResolvedValue(AUTHOR);
    const [feePaid] = extrinsicEvents(
      3_000_100,
      [['transactionPayment', 'TransactionFeePaid', { who: ALICE, actualFee: '250', tip: '0' }]],
      { specVersion: 7_000_000 }
    );

    await handleTransactionFeeCharged(feePaid);

    expect(balance(ALICE)?.free).toBe(BigInt(-250));
    expect(balance(AUTHOR)?.free).toBe(BigInt(250));
    expect(entries().find(r => r.accountId === AUTHOR)).toMatchObject({
      kind: MovementKind.BlockAuthorFee,
      direction: EntryDirection.Credit,
      amountAbs: BigInt(250),
    });
    // the author's income is not a fee they paid
    expect(balance(AUTHOR)?.totalFeesPaid ?? BigInt(0)).toBe(BigInt(0));
  });

  it('before v5.4.2: leaves the treasury its announced cut of a protocol fee, and pays the author the rest', async () => {
    (blockAuthor as jest.Mock).mockResolvedValue(AUTHOR);
    const [feeCharged] = extrinsicEvents(
      3_000_150,
      [
        ['protocolFee', 'FeeCharged', { who: ALICE, amount: '500' }],
        ['treasury', 'TreasuryReimbursement', { did: '0xdid', amount: '400' }],
      ],
      { specVersion: 5_000_002 }
    );

    await handleTransactionFeeCharged(feeCharged);

    expect(balance(ALICE)?.free).toBe(BigInt(-500));
    expect(balance(AUTHOR)?.free).toBe(BigInt(100));
  });

  it('v5.4.0: leaves the treasury its cut announced just before TransactionFeePaid', async () => {
    (blockAuthor as jest.Mock).mockResolvedValue(AUTHOR);
    const [, feePaid] = extrinsicEvents(
      3_000_160,
      [
        ['treasury', 'TreasuryReimbursement', { did: '0xdid', amount: '76962' }],
        ['transactionPayment', 'TransactionFeePaid', { who: ALICE, actualFee: '96203', tip: '0' }],
      ],
      { specVersion: 5_004_000 }
    );

    await handleTransactionFeeCharged(feePaid);

    expect(balance(AUTHOR)?.free).toBe(BigInt(19241));
  });

  it('before v8: credits nobody when the block has no author, as the chain drops the fee', async () => {
    (blockAuthor as jest.Mock).mockResolvedValue(undefined);
    const [feePaid] = extrinsicEvents(
      3_000_200,
      [['protocolFee', 'FeeCharged', { who: ALICE, amount: '90' }]],
      { specVersion: 7_000_000 }
    );

    await handleTransactionFeeCharged(feePaid);

    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ accountId: ALICE, kind: MovementKind.Fee });
  });

  it('on v8: files the deposit before TransactionFeePaid as the author being paid, not new POLYX', async () => {
    (blockAuthor as jest.Mock).mockResolvedValue(AUTHOR);
    const [withdraw, refund, paid, feePaid] = extrinsicEvents(3_000_300, [
      ['balances', 'Withdraw', { who: ALICE, amount: '500' }],
      ['balances', 'Deposit', { who: ALICE, amount: '200' }],
      ['balances', 'Deposit', { who: AUTHOR, amount: '300' }],
      ['transactionPayment', 'TransactionFeePaid', { who: ALICE, actualFee: '300', tip: '0' }],
    ]);

    await handleBalanceBurned(withdraw);
    await handleBalanceMinted(refund);
    await handleBalanceMinted(paid);
    await handleTransactionFeeCharged(feePaid);

    expect(entries().find(r => r.accountId === AUTHOR)?.kind).toBe(MovementKind.BlockAuthorFee);
    expect(balance(ALICE)?.totalFeesPaid).toBe(BigInt(300));
    expect(entries().some(r => r.kind === MovementKind.Mint)).toBe(false);
  });

  it('on v8: files the deposit after FeeCharged as the author being paid a protocol fee', async () => {
    (blockAuthor as jest.Mock).mockResolvedValue(AUTHOR);
    const [withdraw, charged, paid] = extrinsicEvents(3_000_400, [
      ['balances', 'Withdraw', { who: ALICE, amount: '90' }],
      ['protocolFee', 'FeeCharged', { who: ALICE, amount: '90' }],
      ['balances', 'Deposit', { who: AUTHOR, amount: '90' }],
    ]);

    await handleBalanceBurned(withdraw);
    await handleTransactionFeeCharged(charged);
    await handleBalanceMinted(paid);

    expect(entries().find(r => r.accountId === AUTHOR)?.kind).toBe(MovementKind.BlockAuthorFee);
  });

  it('on v8: leaves a deposit that sits next to no fee as new POLYX', async () => {
    (blockAuthor as jest.Mock).mockResolvedValue(AUTHOR);
    const [paid] = extrinsicEvents(3_000_500, [
      ['balances', 'Deposit', { who: AUTHOR, amount: '300' }],
    ]);

    await handleBalanceMinted(paid);

    expect(entries()[0].kind).toBe(MovementKind.Mint);
  });
});

/**
 * Before v5.4.0 the transaction fee was charged and paid to the block author with no event at all,
 * so both halves were missing — the reconciler saw signers holding less than the index said and
 * validators holding more. Priced the way the chain priced it, `payment.queryInfo` at the parent
 * block, which reproduced the missing amount to the unit on the replay.
 */
describe('a fee its runtime did not announce', () => {
  const AUTHOR = '5HCBK1bGMAcJNYmm1zE1MTkiYD4gFezfLewc3rEjj1FmigyE';
  const PAYING_KEY = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy';

  const phase = (extrinsicIdx: number | undefined) => ({
    isApplyExtrinsic: extrinsicIdx !== undefined,
    asApplyExtrinsic: { toNumber: () => extrinsicIdx },
  });

  const record = (idx: number, section: string, method: string, data: unknown[] = []) => ({
    phase: phase(idx),
    event: {
      section,
      method,
      data,
      meta: {
        fields: data.map(() => ({
          name: { isSome: false },
          typeName: { isSome: true, unwrap: () => mockCodec('Dummy') },
        })),
      },
    },
  });

  /** The treasury's 80% cut, announced just before the extrinsic closes. */
  const treasuryCut = (idx: number, amount: string) =>
    record(idx, 'treasury', 'TreasuryReimbursement', [
      { toString: () => '0xdid' },
      { toString: () => amount },
    ]);

  /** The dispatch info a closing event carries: the weight actually charged, after any refund. */
  const dispatchInfo = (weight: string) => ({
    weight: { toString: () => weight },
    toRawType: () => 'DispatchInfo',
    toJSON: () => ({ weight: Number(weight) }),
  });
  const dispatchError = {
    toString: () => 'error',
    toRawType: () => 'DispatchError',
    toJSON: () => ({}),
  };

  /** The events one extrinsic emits: its call's own, the treasury's cut if any, then its close. */
  const extrinsicRecords = (
    idx: number,
    cut: string | null,
    weight = '3080081465',
    failed = false
  ) => [
    record(idx, 'balances', 'Transfer'),
    ...(cut === null ? [] : [treasuryCut(idx, cut)]),
    failed
      ? record(idx, 'system', 'ExtrinsicFailed', [dispatchError, dispatchInfo(weight)])
      : record(idx, 'system', 'ExtrinsicSuccess', [dispatchInfo(weight)]),
  ];

  // 144 bytes at weight 3,080,081,465 costs 186,554, and 149,243 is floor(186,554 × 80%)
  const signedExtrinsic = ({
    specVersion,
    signed = true,
    section = 'balances',
    cut = '149243',
    len = 144,
    weight = '3080081465',
    failed = false,
  }: {
    specVersion: number;
    signed?: boolean;
    section?: string;
    cut?: string | null;
    len?: number;
    weight?: string;
    failed?: boolean;
  }) => {
    const extrinsic = {
      isSigned: signed,
      signer: { toString: () => ALICE },
      method: { section, method: 'transfer' },
      encodedLength: len,
      tip: { toString: () => '0' },
      toHex: () => '0xextrinsic',
    };
    const unsigned = { isSigned: false };
    const block = {
      block: {
        header: { number: { toString: () => '4000000' }, parentHash: '0xparent' },
        extrinsics: [unsigned, unsigned, extrinsic] as unknown[],
      },
      timestamp: new Date('2021-06-01T00:00:00.000Z'),
      specVersion,
      events: extrinsicRecords(2, cut, weight, failed) as unknown[],
    };

    return {
      idx: 2,
      block,
      extrinsic,
      events: [],
      success: true,
    } as any;
  };

  // the chain's quote prices the weight a call declared; the fee is computed instead, so it is never
  // asked, and a quote that disagrees shows if it were
  const queryInfo = jest.fn();
  const quote = (fee: string) => ({ partialFee: { toString: () => fee } });

  beforeEach(() => {
    queryInfo.mockReset().mockResolvedValue(quote('400011'));
    (globalThis as any).api.rpc = { payment: { queryInfo } };
    (blockAuthor as jest.Mock).mockResolvedValue(AUTHOR);
    // the signer pays, as for every call but a few (see feePayer.test.ts)
    (resolveFeePayer as jest.Mock).mockImplementation((extrinsic: any) =>
      Promise.resolve(extrinsic.extrinsic.signer.toString())
    );
  });

  it("reads the fee back from the treasury's cut, and pays the author the rest", async () => {
    await postUneventedTransactionFee(signedExtrinsic({ specVersion: 5_003_001 }));

    expect(balance(ALICE)?.free).toBe(BigInt(-186554));
    expect(balance(ALICE)?.totalFeesPaid).toBe(BigInt(186554));
    // 186,554 − 149,243
    expect(balance(AUTHOR)?.free).toBe(BigInt(37311));
    expect(queryInfo).not.toHaveBeenCalled();
  });

  it("files both halves on the extrinsic's closing event, which it indexes, clear of the call's own", async () => {
    await postUneventedTransactionFee(signedExtrinsic({ specVersion: 5_003_001 }));

    expect(entries().every(r => r.movementId === '0004000000/0000000002')).toBe(true);
    expect(db['Event']?.['0004000000/0000000002']).toBeDefined();
  });

  it('leaves an extrinsic whose runtime announced its fee to TransactionFeePaid', async () => {
    const extrinsic = signedExtrinsic({ specVersion: 5_004_000 });
    extrinsic.block.events.splice(1, 0, record(2, 'transactionPayment', 'TransactionFeePaid'));

    await postUneventedTransactionFee(extrinsic);

    expect(queryInfo).not.toHaveBeenCalled();
    expect(entries()).toHaveLength(0);
  });

  /**
   * The node labels blocks near an upgrade with the neighbouring runtime's spec. A block that ran
   * under a runtime announcing no fee is still reconstructed when its label says otherwise.
   */
  it('goes by what the extrinsic emitted, not by the spec the block is labelled with', async () => {
    await postUneventedTransactionFee(signedExtrinsic({ specVersion: 6_000_001 }));

    expect(balance(ALICE)?.free).toBe(BigInt(-186554));
  });

  it('charges nothing for an unsigned extrinsic', async () => {
    await postUneventedTransactionFee(signedExtrinsic({ specVersion: 5_003_001, signed: false }));

    expect(queryInfo).not.toHaveBeenCalled();
    expect(entries()).toHaveLength(0);
  });

  it('charges the subsidiser rather than the signer, except for the relayer pallet itself', async () => {
    db['Subsidy'] = {
      s1: {
        id: 's1',
        beneficiaryAccountId: ALICE,
        payingAccountId: PAYING_KEY,
        isAccepted: true,
        isRemoved: false,
      },
    };
    ((globalThis as any).store.getByField as jest.Mock).mockImplementation(
      (entity: string, field: string, value: unknown) =>
        Promise.resolve(Object.values(db[entity] ?? {}).filter(row => row[field] === value))
    );

    await postUneventedTransactionFee(signedExtrinsic({ specVersion: 5_003_001 }));

    expect(balance(PAYING_KEY)?.free).toBe(BigInt(-186554));
    expect(balance(ALICE)).toBeUndefined();
  });

  it('charges the fee to the account the runtime chose, not the signer', async () => {
    (resolveFeePayer as jest.Mock).mockResolvedValueOnce(BOB);

    await postUneventedTransactionFee(signedExtrinsic({ specVersion: 3_000 }));

    expect(balance(BOB)?.free).toBe(BigInt(-186554));
    expect(balance(ALICE)).toBeUndefined();
  });

  it("subsidises the payer's fee, not the signer's", async () => {
    (resolveFeePayer as jest.Mock).mockResolvedValueOnce(BOB);
    // the signer has a subsidy and the payer does not: on chain, nothing is subsidised
    db['Subsidy'] = {
      sub: {
        id: 'sub',
        beneficiaryAccountId: ALICE,
        payingAccountId: PAYING_KEY,
        isAccepted: true,
        isRemoved: false,
      },
    };

    await postUneventedTransactionFee(signedExtrinsic({ specVersion: 3_000 }));

    expect(balance(BOB)?.free).toBe(BigInt(-186554));
    expect(balance(PAYING_KEY)).toBeUndefined();
  });

  /**
   * `sudo` calls are refunded their whole fee after they run, so the runtime takes nothing and the
   * treasury announces no cut — while the quote still prices the weight the call declared. A
   * testnet runtime upgrade was quoted at 131 POLYX that nobody paid.
   */
  it('charges nothing when the treasury took no cut, whatever the quote says', async () => {
    queryInfo.mockResolvedValue(quote('131363199'));

    await postUneventedTransactionFee(signedExtrinsic({ specVersion: 5_000_002, cut: null }));

    expect(entries()).toHaveLength(0);
    expect(queryInfo).not.toHaveBeenCalled();
  });

  /**
   * `staking.rebond` used less weight than it declared and was refunded the difference: testnet
   * block 553,976 was quoted 81,413 at its declared 869,154,000 weight, and charged 68,299 at the
   * 585,000,000 it used, of which the treasury took 54,639.
   */
  it('charges a refunded call for the weight it used, not the weight it declared', async () => {
    await postUneventedTransactionFee(
      signedExtrinsic({ specVersion: 3_000, len: 113, weight: '585000000', cut: '54639' })
    );

    expect(balance(ALICE)?.free).toBe(BigInt(-68299));
    expect(balance(AUTHOR)?.free).toBe(BigInt(13660));
    expect(queryInfo).not.toHaveBeenCalled();
  });

  /**
   * A cut that is a multiple of 4 allows two fees: 78,124 is floor(97,655 × 80%) and
   * floor(97,656 × 80%). Testnet block 5,092,018's `contracts.call` was charged 97,656, the fee its
   * length and used weight give; the old tie-break took 97,655, a unit short on every such call.
   */
  it('charges exactly the fee the chain took when the cut allows two', async () => {
    await postUneventedTransactionFee(
      signedExtrinsic({ specVersion: 5_000_003, len: 152, weight: '1136599783', cut: '78124' })
    );

    expect(balance(ALICE)?.free).toBe(BigInt(-97656));
    expect(balance(AUTHOR)?.free).toBe(BigInt(97656 - 78124));
  });

  it('reads the weight from a failed extrinsic too, which was still charged', async () => {
    // `ExtrinsicFailed(error, info)` carries its dispatch info second
    await postUneventedTransactionFee(
      signedExtrinsic({
        specVersion: 5_000_003,
        len: 152,
        weight: '1136599783',
        cut: '78124',
        failed: true,
      })
    );

    expect(balance(ALICE)?.free).toBe(BigInt(-97656));
  });

  it("records it, and takes the lowest fee the cut allows, when the computed fee doesn't fit", async () => {
    // 75,804 allows 94,755 or 94,756, and the default extrinsic computes to 186,554
    await postUneventedTransactionFee(signedExtrinsic({ specVersion: 3_000, cut: '75804' }));

    expect(balance(ALICE)?.free).toBe(BigInt(-94755));
    expect(Object.values(db['IndexerAnomaly'] ?? {})).toHaveLength(1);
  });
});

describe("a pre-v8 slash's reporters are paid, unannounced", () => {
  // Testnet block 7,751,343 (spec 5003001): the era-2159 slash of 5Gx24bnY… by 12,750 POLYX, with
  // one reporter paid 637.5 POLYX and the treasury the remaining 12,112.5
  const OFFENDER = BOB;
  const REPORTER = '5EFbtwDBQu64WjUGqAgC3kuaiH86E34CHtqxbN7zAgwwT2cg';
  const SPEC = 5_003_001;

  type Deferred = { validator: string; own: string; reporters: string[]; payout: string };

  /** A `Twox64Concat` key on the era, which the registry decodes back to the era. */
  const eraKey = (era: number) => {
    const bytes = new Uint8Array(20);
    new DataView(bytes.buffer).setUint32(16, era, true);
    return { toU8a: () => bytes, toHex: () => `0xunappliedSlashes:${era}` };
  };
  let undecodable: number[] = [];

  const getKeysPaged = jest.fn();
  const getStorage = jest.fn();
  const getHeader = jest.fn();
  const registryRuntime = (globalThis as any).api.runtimeVersion;
  const getRuntimeVersion = jest.fn();

  /** `staking.unappliedSlashes`, as the parent block's state holds it. */
  const deferredSlashes = (byEra: Record<number, Deferred[]>) => {
    getKeysPaged.mockReset().mockResolvedValue(Object.keys(byEra).map(Number).map(eraKey));
    getStorage
      .mockReset()
      .mockImplementation((key: { toU8a: () => Uint8Array }) =>
        Promise.resolve({ isNone: false, unwrap: () => ({ toU8a: () => key.toU8a() }) })
      );

    (globalThis as any).api.query = {
      staking: {
        unappliedSlashes: {
          keyPrefix: () => '0xunappliedSlashes',
          creator: { meta: { type: { isMap: true, asMap: { value: 587 } } } },
        },
        // the slashed stash's staking lock is resynced from its ledger
        bonded: jest.fn().mockResolvedValue({ toJSON: () => null }),
        ledger: jest.fn().mockResolvedValue({ toJSON: () => null }),
      },
    };
    // the block's registry describes its own runtime, and no upgrade came in the parent, so the
    // parent's state is readable without asking the chain which runtime wrote it
    (globalThis as any).api.runtimeVersion = {
      ...registryRuntime,
      specVersion: { toNumber: () => SPEC },
    };
    getHeader.mockReset();
    getRuntimeVersion.mockReset();
    (globalThis as any).api.rpc = {
      chain: { getHeader },
      state: { getKeysPaged, getStorage, getRuntimeVersion },
    };
    (globalThis as any).api.registry = {
      chainSS58: 42,
      createLookupType: () => 'Lookup587',
      createType: (type: string, input: Uint8Array | string) => {
        if (type === 'StorageKey') {
          const era = Number((input as string).split(':')[1]);
          return { setMeta: () => ({ args: undecodable.includes(era) ? [] : [mockCodec(era)] }) };
        }
        const bytes = input as Uint8Array;
        return byEra[new DataView(bytes.buffer).getUint32(16, true)].map(slash => ({
          validator: mockCodec(slash.validator),
          own: mockCodec(slash.own),
          reporters: slash.reporters.map(mockCodec),
          payout: mockCodec(slash.payout),
        }));
      },
    };
  };

  afterEach(() => {
    undecodable = [];
    (globalThis as any).api.query = {};
    (globalThis as any).api.runtimeVersion = registryRuntime;
    delete (globalThis as any).api.rpc;
  });

  /** The block's event records from the `Slash`es on, as `apply_slash` emits them. */
  const slashEvents = (
    slashes: [stash: string, amount: string][],
    toTreasury: string | null,
    specVersion = SPEC
  ): SubstrateEvent[] => {
    const records = [
      ...slashes.map(([stash, amount]) => ['staking', 'Slash', [stash, amount]] as const),
      ...(toTreasury === null
        ? []
        : [['treasury', 'TreasuryReimbursement', ['0x' + '00'.repeat(32), toTreasury]] as const]),
    ].map(([section, method, data]) => ({
      phase: { isApplyExtrinsic: false },
      event: { section, method, data: data.map(mockCodec) },
    }));

    return slashes.map(([stash, amount], index) => {
      const event = tupleEvent('staking', 'Slash', [stash, amount], specVersion);
      const block = (event as any).block;

      block.block = {
        header: { number: { toString: () => '7751343' }, parentHash: '0xparent' },
      };
      block.events = records;
      (event as { idx: number }).idx = index;

      return event;
    });
  };

  const anomalies = (): Row[] => Object.values(db['IndexerAnomaly'] ?? {});

  it('credits the reporter the payout the deferred slash names, from the offender', async () => {
    deferredSlashes({
      2159: [
        { validator: OFFENDER, own: '12750000000', reporters: [REPORTER], payout: '637500000' },
      ],
    });

    const [slash] = slashEvents([[OFFENDER, '12750000000']], '12112500000');
    await handleStakingSlash(slash);

    expect(balance(REPORTER)?.free).toBe(BigInt(637_500_000));
    expect(balance(OFFENDER)?.free).toBe(BigInt(-12_750_000_000));
    expect(entries().find(row => row.accountId === REPORTER)).toMatchObject({
      kind: MovementKind.StakingReward,
      direction: EntryDirection.Credit,
      counterpartyAddress: OFFENDER,
    });
    // read where the slash still is: the parent, since applying it takes it out of storage
    expect(getKeysPaged).toHaveBeenCalledWith(
      '0xunappliedSlashes',
      1000,
      '0xunappliedSlashes',
      '0xparent'
    );
    expect(anomalies()).toHaveLength(0);
  });

  it('pays no one when the offence had no reporters, and the treasury takes it all', async () => {
    // testnet block 7,737,503: era 2155's slash, with 2159's still waiting behind it
    deferredSlashes({
      2155: [{ validator: OFFENDER, own: '1673299719', reporters: [], payout: '83664986' }],
      2159: [{ validator: ALICE, own: '12750000000', reporters: [REPORTER], payout: '637500000' }],
    });

    const [slash] = slashEvents([[OFFENDER, '1673299719']], '1673299719');
    await handleStakingSlash(slash);

    expect(balance(REPORTER)).toBeUndefined();
    expect(anomalies()).toHaveLength(0);
  });

  it("records it, and pays no one, when a deferred slash's era can't be decoded", async () => {
    deferredSlashes({
      2159: [
        { validator: OFFENDER, own: '12750000000', reporters: [REPORTER], payout: '637500000' },
      ],
    });
    undecodable = [2159];

    const [slash] = slashEvents([[OFFENDER, '12750000000']], '12112500000');
    await handleStakingSlash(slash);

    expect(balance(REPORTER)).toBeUndefined();
    expect(anomalies()).toHaveLength(1);
    expect(anomalies()[0].detail).toContain('the deferred slashes could not be read');
  });

  it('applies the oldest era when the same validator has more than one slash waiting', async () => {
    deferredSlashes({
      2160: [{ validator: OFFENDER, own: '1000', reporters: [ALICE], payout: '50' }],
      2159: [{ validator: OFFENDER, own: '1000', reporters: [REPORTER], payout: '100' }],
    });

    const [slash] = slashEvents([[OFFENDER, '1000']], '900');
    await handleStakingSlash(slash);

    expect(balance(REPORTER)?.free).toBe(BigInt(100));
    expect(balance(ALICE)).toBeUndefined();
  });

  it('keeps an entry for each of several reporters', async () => {
    deferredSlashes({
      2159: [{ validator: OFFENDER, own: '1000', reporters: [REPORTER, ALICE], payout: '100' }],
    });

    const [slash] = slashEvents([[OFFENDER, '1000']], '900');
    await handleStakingSlash(slash);

    // filed under one event, they used to share an id and overwrite each other
    const credits = entries().filter(r => r.kind === MovementKind.StakingReward);
    expect(credits.map(r => r.accountId).sort()).toEqual([REPORTER, ALICE].sort());
    expect(balance(REPORTER)?.free).toBe(BigInt(50));
    expect(balance(ALICE)?.free).toBe(BigInt(50));
    expect(anomalies()).toHaveLength(0);
  });

  it('pays once per offence, on the validator, not again on its nominators', async () => {
    const NOMINATOR = '5HCBK1bGMAcJNYmm1zE1MTkiYD4gFezfLewc3rEjj1FmigyE';
    deferredSlashes({
      2159: [{ validator: OFFENDER, own: '1000', reporters: [REPORTER], payout: '120' }],
    });

    // the treasury's share is what both slashes leave after the reporter
    for (const event of slashEvents(
      [
        [OFFENDER, '1000'],
        [NOMINATOR, '400'],
      ],
      '1280'
    )) {
      await handleStakingSlash(event);
    }

    expect(balance(REPORTER)?.free).toBe(BigInt(120));
    expect(anomalies()).toHaveLength(0);
  });

  it('records it when the treasury received something other than the rest', async () => {
    deferredSlashes({
      2159: [
        { validator: OFFENDER, own: '12750000000', reporters: [REPORTER], payout: '637500000' },
      ],
    });

    const [slash] = slashEvents([[OFFENDER, '12750000000']], '12750000000');
    await handleStakingSlash(slash);

    expect(anomalies()).toHaveLength(1);
    expect(anomalies()[0].detail).toContain('should leave 12112500000 for the treasury');
  });

  it("records it, and pays no one, when the parent's state can't be read", async () => {
    // the first block after an upgrade: the parent's state has the old runtime's layout
    deferredSlashes({
      2159: [
        { validator: OFFENDER, own: '12750000000', reporters: [REPORTER], payout: '637500000' },
      ],
    });
    // ...so the index holds that upgrade's row, and the chain names the runtime that wrote the parent
    db['ChainUpgrade'] = {
      [String(SPEC).padStart(10, '0')]: { specVersionId: SPEC, firstBlockId: '0007751342' },
    };
    getHeader.mockResolvedValue({ parentHash: '0xgrandparent' });
    getRuntimeVersion.mockResolvedValue({ specVersion: { toNumber: () => 1 } });

    const [slash] = slashEvents([[OFFENDER, '12750000000']], '12112500000');
    await handleStakingSlash(slash);

    expect(balance(REPORTER)).toBeUndefined();
    expect(anomalies()).toHaveLength(1);
    expect(anomalies()[0].detail).toContain('could not be read');
  });

  it('records it, and pays no one, when a deferred slash does not decode', async () => {
    deferredSlashes({
      2159: [
        { validator: OFFENDER, own: '12750000000', reporters: [REPORTER], payout: '637500000' },
      ],
    });
    const registry = (globalThis as any).api.registry;
    const createType = registry.createType;
    registry.createType = (type: string, input: unknown) => {
      if (type === 'StorageKey') {
        return createType(type, input);
      }
      throw new Error('Unable to decode Lookup587');
    };

    const [slash] = slashEvents([[OFFENDER, '12750000000']], '12112500000');
    await handleStakingSlash(slash);

    expect(balance(REPORTER)).toBeUndefined();
    expect(anomalies()).toHaveLength(1);
    expect(anomalies()[0].detail).toContain('could not be read');
  });

  it('fails the block when the deferred slashes cannot be fetched', async () => {
    deferredSlashes({
      2159: [
        { validator: OFFENDER, own: '12750000000', reporters: [REPORTER], payout: '637500000' },
      ],
    });
    getStorage.mockReset().mockRejectedValue(new Error('WebSocket is not connected'));

    const [slash] = slashEvents([[OFFENDER, '12750000000']], '12112500000');

    await expect(handleStakingSlash(slash)).rejects.toThrow('WebSocket is not connected');
    expect(balance(REPORTER)).toBeUndefined();
  });

  it('leaves a v8 slash alone: it comes out of the hold and is burned, with no treasury share', async () => {
    deferredSlashes({});

    await handleStakingSlash(
      structEvent(
        'staking',
        'Slashed',
        { staker: OFFENDER, amount: '400' },
        { specVersion: 8_000_020 }
      )
    );

    expect(getKeysPaged).not.toHaveBeenCalled();
  });
});
