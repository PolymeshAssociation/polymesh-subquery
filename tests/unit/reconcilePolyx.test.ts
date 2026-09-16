/**
 * In-flight POLYX reconciliation (D11). Every Nth block for touched accounts, and always after a
 * `BalanceSet` / `DustLost`, `reconcileAccount` reads `system.account` immediately (during event
 * handling, while `api` is still bound to that block) and queues the snapshot. `reconcileBlock`,
 * run from the *next* block's handler — the block handler runs before its own block's events, so
 * only the previous block's derived state is final by then — does the compare-and-correct against
 * that already-captured snapshot. On a mismatch it records a `BalanceReconciliationDrift` anomaly
 * and corrects the derived value so the drift cannot compound.
 */

import { SubstrateBlock } from '@subql/types';
import {
  __resetOnChainCache,
  reconcileAccount,
  reconcileBlock,
  reconcileStats,
} from '../../src/mappings/entities/identities/reconcilePolyx';
import { __resetStakingCaches } from '../../src/utils/staking';

const ADDR = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

const storeGet = (): jest.Mock => (globalThis as any).store.get as jest.Mock;
const storeSet = (): jest.Mock => (globalThis as any).store.set as jest.Mock;

const codec = (v: unknown) => ({
  toString: () => (typeof v === 'string' ? v : JSON.stringify(v)),
  toJSON: () => v,
});

const block = (height: number, specVersion = 8_000_000): SubstrateBlock =>
  ({
    block: { header: { number: { toString: () => String(height) } } },
    timestamp: new Date('2024-01-01T00:00:00Z'),
    specVersion,
  } as unknown as SubstrateBlock);

/** A pre-v8 block, where a bond is a `'staking '` lock rather than a `Staking` hold. */
const v7Block = (height: number): SubstrateBlock => block(height, 7_000_000);

/**
 * One block's worth of the real handler order: block K's handler (which decides whether K is a
 * sample), then K's event queueing the account, then block K+1's handler flushing it.
 */
const reconcile = async (
  height: number,
  opts: { force?: boolean; eventIdx?: number } = {}
): Promise<void> => {
  await reconcileBlock(block(height));
  await reconcileAccount(ADDR, '0000000000', block(height), opts);
  await reconcileBlock(block(height + 1));
};

let db: Record<string, Record<string, any>>;

const setDerived = (row: Partial<Record<string, bigint | any[]>>) => {
  db['AccountBalance'] = {
    [ADDR]: {
      id: ADDR,
      accountId: ADDR,
      free: BigInt(0),
      reserved: BigInt(0),
      frozen: BigInt(0),
      total: BigInt(0),
      transferable: BigInt(0),
      bonded: BigInt(0),
      otherReserved: BigInt(0),
      totalReceived: BigInt(0),
      totalSent: BigInt(0),
      totalFeesPaid: BigInt(0),
      totalRewards: BigInt(0),
      totalSlashed: BigInt(0),
      movementCount: 0,
      locks: [],
      holds: [],
      updatedEventId: '0000000000/0000000000',
      ...row,
    },
  };
};

const setChain = (
  free: string,
  reserved: string,
  frozen: string,
  /**
   * The freeze breakdown the correction rebuilds `locks`/`holds` from: `holds` is v8's
   * `balances.holds(who)` (each `id` a composite `RuntimeHoldReason`), `ledgerTotal` is pre-v8's
   * `staking.ledger(controller).total`.
   */
  {
    holds = [],
    ledgerTotal,
    locks = [],
  }: { holds?: unknown[]; ledgerTotal?: string; locks?: unknown[] } = {}
) => {
  (globalThis as any).api.query = {
    system: {
      account: jest.fn().mockResolvedValue({
        data: { free: codec(free), reserved: codec(reserved), frozen: codec(frozen) },
      }),
    },
    balances: {
      holds: jest.fn().mockResolvedValue(codec(holds)),
      locks: jest.fn().mockResolvedValue(codec(locks)),
    },
    staking: {
      bonded: jest.fn().mockResolvedValue(codec(null)),
      ledger: jest
        .fn()
        .mockResolvedValue(
          codec(ledgerTotal === undefined ? null : { total: ledgerTotal, active: ledgerTotal })
        ),
    },
  };
};

const anomalies = () =>
  storeSet()
    .mock.calls.filter(([e]) => e === 'IndexerAnomaly')
    .map(([, , row]) => row);

beforeEach(() => {
  __resetOnChainCache();
  __resetStakingCaches();
  db = {};
  storeGet().mockImplementation((entity: string, id: string) => Promise.resolve(db[entity]?.[id]));
  storeSet().mockImplementation((entity: string, id: string, data: any) => {
    (db[entity] ??= {})[id] = { ...data };
    return Promise.resolve();
  });
});

// Values are in base units (6 decimals); drifts here are far above the MIN_DRIFT (100 POLYX) floor.
const P = (polyx: number): bigint => BigInt(polyx) * BigInt(1_000_000);

describe('reconcileAccount / reconcileBlock', () => {
  it('does nothing when the derived balance agrees with chain state', async () => {
    setDerived({ free: P(1000), total: P(1000), transferable: P(1000) });
    setChain(P(1000).toString(), '0', '0');

    await reconcile(9000, { force: true });

    expect(anomalies()).toHaveLength(0);
  });

  it('ignores sub-100-POLYX drift (weight-fee gap / mid-block sample noise)', async () => {
    setDerived({ free: P(1000) + BigInt(50_000_000), total: P(1000) });
    setChain(P(1000).toString(), '0', '0');

    await reconcile(9000, { force: true });

    expect(anomalies()).toHaveLength(0);
  });

  it('records a drift anomaly and corrects each pool independently', async () => {
    setDerived({ free: P(900), reserved: P(100), total: P(1000) });
    setChain(P(1000).toString(), P(50).toString(), '0');

    await reconcile(9000, { force: true, eventIdx: 3 });

    expect(anomalies()).toHaveLength(1);
    expect(anomalies()[0]).toMatchObject({ kind: 'BalanceReconciliationDrift' });
    expect(anomalies()[0].detail).toContain(`free ${P(900)} vs ${P(1000)}`);

    expect(db['AccountBalance'][ADDR]).toMatchObject({
      free: P(1000),
      reserved: P(50),
      total: P(1050),
    });
  });

  it('rebuilds v8 holds from chain, so bonded and otherReserved stay consistent', async () => {
    // F4: the correction used to file the whole frozen amount under the `'staking '` lock on every
    // chain version, and never touched `holds` — so on v8 `bonded` counted an unrelated freeze,
    // `SUM(holds)` no longer matched the corrected `reserved`, and the next `Unlocked` (which
    // reads a `'staking '` lock on a v8 account as an un-migrated pre-v8 lock) wiped `frozen`.
    setDerived({ free: P(1000), reserved: BigInt(0), total: P(1000) });
    setChain(P(1000).toString(), P(700).toString(), P(50).toString(), {
      holds: [
        { id: { staking: 'Staking' }, amount: P(600).toString() },
        { id: { preimage: 'Preimage' }, amount: P(100).toString() },
      ],
    });

    await reconcile(9000, { force: true });

    expect(db['AccountBalance'][ADDR]).toMatchObject({
      reserved: P(700),
      bonded: P(600),
      otherReserved: P(100),
      frozen: P(50),
      holds: [
        { reason: 'Staking', amount: P(600) },
        { reason: 'Preimage', amount: P(100) },
      ],
    });
    // never the staking lock on v8 — `handleBalanceUnlocked` would clear it
    expect(db['AccountBalance'][ADDR].locks).toEqual([{ lockId: 'residual', amount: P(50) }]);
  });

  /**
   * The v8 lock → hold migration runs in two passes ~420k blocks apart: the first adds the
   * `Staking` hold and leaves the old `'staking '` lock, the second drops the lock with an
   * `Unlocked`. A correction landing between them used to re-file that still-present lock as
   * `residual`, so the second pass — recognised by the lock's id — never cleared it. Ten accounts
   * on a testnet resync ended up with `frozen` of up to 4.96M POLYX against a chain value of 0.
   */
  it('keeps a still-present staking lock as a staking lock between the v8 migration passes', async () => {
    setDerived({ free: P(900), total: P(900) });
    setChain(P(1000).toString(), P(213).toString(), P(213).toString(), {
      holds: [{ id: { staking: 'Staking' }, amount: P(213).toString() }],
      // `'staking '` as the chain encodes a LockIdentifier
      locks: [{ id: '0x7374616b696e6720', amount: P(213).toString(), reasons: 'All' }],
    });

    await reconcile(9000, { force: true });

    expect(db['AccountBalance'][ADDR].locks).toEqual([
      { lockId: 'staking ', amount: P(213), reasons: 'staking' },
    ]);
    // the hold and the lock cover the same bond, so it is not counted twice
    expect(db['AccountBalance'][ADDR]).toMatchObject({ bonded: P(213), frozen: P(213) });
  });

  it('files v8 frozen as residual once the second pass has dropped the staking lock', async () => {
    setDerived({ free: P(900), total: P(900) });
    setChain(P(1000).toString(), P(213).toString(), P(40).toString(), {
      holds: [{ id: { staking: 'Staking' }, amount: P(213).toString() }],
      locks: [],
    });

    await reconcile(9000, { force: true });

    expect(db['AccountBalance'][ADDR].locks).toEqual([{ lockId: 'residual', amount: P(40) }]);
  });

  it('pins the pre-v8 staking lock to ledger.total and files the remainder as residual', async () => {
    setDerived({ free: P(1000), frozen: BigInt(0), transferable: P(1000) });
    setChain(P(1000).toString(), '0', P(500).toString(), { ledgerTotal: P(400).toString() });

    await reconcileAccount(ADDR, '0000009000', v7Block(9000), { force: true });
    await reconcileBlock();

    expect(db['AccountBalance'][ADDR]).toMatchObject({
      frozen: P(500),
      bonded: P(400),
      transferable: P(500),
      locks: [
        { lockId: 'staking ', amount: P(400), reasons: 'staking' },
        { lockId: 'residual', amount: P(500) },
      ],
    });
  });

  /**
   * The dictionary hands a worker only the blocks carrying events it subscribes to (~1.6% of
   * heights on testnet), so `height % 2000 === 0` almost never matched a processed block. Sampling
   * now measures the gap since this worker's last sample, independent of which heights it sees.
   */
  it('samples at most once per 2000 heights, at whatever heights the worker is handed', async () => {
    setChain(P(999).toString(), '0', '0');

    // not a multiple of 2000 — still sampled, being the first block this worker has seen
    setDerived({ free: BigInt(1) });
    await reconcile(12_345);
    expect(anomalies()).toHaveLength(1);

    // only 500 heights on — not sampled
    setDerived({ free: BigInt(1) });
    await reconcile(12_845);
    expect(anomalies()).toHaveLength(1);

    // 2000 heights after the last sample — sampled again
    setDerived({ free: BigInt(1) });
    await reconcile(14_345);
    expect(anomalies()).toHaveLength(2);
  });

  it('a forced reconcile runs even between sample points', async () => {
    setChain(P(999).toString(), '0', '0');

    setDerived({ free: BigInt(1) });
    await reconcile(12_345);

    setDerived({ free: BigInt(1) });
    await reconcile(12_346, { force: true });

    expect(anomalies()).toHaveLength(2);
  });

  it('reconciles once per block, not after each event (no mid-block overshoot)', async () => {
    // a %2000 block; the derived balance is already correct once every event has been applied
    setDerived({ free: P(1000), reserved: P(200), total: P(1200) });
    setChain(P(1000).toString(), P(200).toString(), '0');

    await reconcileBlock(block(8000));
    await reconcileAccount(ADDR, '0000008000', block(8000), { eventIdx: 1 });
    await reconcileAccount(ADDR, '0000008000', block(8000), { eventIdx: 5 });
    await reconcileBlock(block(8001));

    expect(anomalies()).toHaveLength(0);
    expect(db['AccountBalance'][ADDR]).toMatchObject({ free: P(1000), reserved: P(200) });
  });

  it('flushes nothing when nothing was queued (block handler runs every block)', async () => {
    setDerived({ free: BigInt(1) });
    setChain(P(999).toString(), '0', '0');

    await reconcileBlock(); // no reconcileAccount call first

    expect(anomalies()).toHaveLength(0);
  });

  /**
   * The positive control the review asked for. This mechanism spent its whole life returning early
   * on a guard that could never pass, and the empty anomaly table that produced was read as "the
   * ledger reconciles". `compared` is the denominator that tells those two apart.
   */
  it('counts the comparisons it actually performs, not just the drifts it finds', async () => {
    setDerived({ free: P(1000), total: P(1000), transferable: P(1000) });
    setChain(P(1000).toString(), '0', '0');

    expect(reconcileStats()).toMatchObject({ compared: 0, drifted: 0 });

    await reconcile(9000, { force: true });

    // agreed, so no anomaly — but the check demonstrably ran
    expect(anomalies()).toHaveLength(0);
    expect(reconcileStats()).toMatchObject({ compared: 1, drifted: 0 });
  });

  it('counts a drift as both compared and drifted', async () => {
    setDerived({ free: P(900), total: P(900) });
    setChain(P(1000).toString(), '0', '0');

    await reconcile(9000, { force: true });

    expect(reconcileStats()).toMatchObject({ compared: 1, drifted: 1 });
  });

  it('does not count a queued account whose comparison never happened', async () => {
    // queued, but the balance row does not exist, so nothing is measured
    setChain(P(1000).toString(), '0', '0');
    db['AccountBalance'] = {};

    await reconcile(9000, { force: true });

    expect(reconcileStats()).toMatchObject({ compared: 0, drifted: 0 });
  });

  /**
   * The flush is not reliably `block + 1`: `--workers` hands each thread a contiguous range and
   * the dictionary makes those ranges sparse, so the next processed block can be far later. A
   * snapshot taken at block K may only be compared against a derived value that is also as of K —
   * otherwise "correcting" to the snapshot writes a stale balance over a newer one and
   * manufactures the very drift it exists to remove.
   */
  it('skips the comparison when the derived row has moved past the snapshot block', async () => {
    setDerived({ free: P(900), total: P(900), updatedEventId: '0000009999/0000000000' as any });
    setChain(P(1000).toString(), '0', '0');

    await reconcileAccount(ADDR, '0000009000', block(9000), { force: true });
    await reconcileBlock();

    // a real 100-POLYX gap, but measured at different points in time — so neither flagged nor "fixed"
    expect(anomalies()).toHaveLength(0);
    expect(db['AccountBalance'][ADDR].free).toBe(P(900));
    expect(reconcileStats()).toMatchObject({ compared: 0, drifted: 0, skippedStale: 1 });
  });

  it('still compares when the row has not been written since the snapshot block', async () => {
    setDerived({ free: P(900), total: P(900), updatedEventId: '0000009000/0000000003' as any });
    setChain(P(1000).toString(), '0', '0');

    await reconcileAccount(ADDR, '0000009000', block(9000), { force: true });
    await reconcileBlock();

    expect(anomalies()).toHaveLength(1);
    expect(db['AccountBalance'][ADDR].free).toBe(P(1000));
    expect(reconcileStats()).toMatchObject({ compared: 1, drifted: 1, skippedStale: 0 });
  });

  it('captures the on-chain snapshot at queue time, not at flush time', async () => {
    // Queue during block 8000 while chain state is X; chain state changes before the flush
    // (block 8001's handler, once `api` is bound to a later block) — the flush must still compare
    // against the snapshot taken back in 8000, not re-read current chain state.
    setDerived({ free: P(1000), total: P(1000) });
    setChain(P(1000).toString(), '0', '0');
    await reconcileAccount(ADDR, '0000008000', block(8000), { force: true });

    setChain(P(5000).toString(), '0', '0'); // chain moved on; must not affect this flush
    await reconcileBlock();

    expect(anomalies()).toHaveLength(0);
  });
});
