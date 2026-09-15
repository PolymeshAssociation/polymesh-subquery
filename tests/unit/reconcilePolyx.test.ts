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
} from '../../src/mappings/entities/identities/reconcilePolyx';
import { __resetControllerCache } from '../../src/utils/staking';

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
 * Queue a reconcile (as an event handler would, mid-block) then flush it (as the *next* block's
 * handler would). `reconcileBlock` takes no block argument — it always flushes whatever the
 * previous block queued, regardless of which block is current when it's called.
 */
const reconcile = async (
  height: number,
  opts: { force?: boolean; eventIdx?: number } = {}
): Promise<void> => {
  await reconcileAccount(ADDR, '0000000000', block(height), opts);
  await reconcileBlock();
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
  { holds = [], ledgerTotal }: { holds?: unknown[]; ledgerTotal?: string } = {}
) => {
  (globalThis as any).api.query = {
    system: {
      account: jest.fn().mockResolvedValue({
        data: { free: codec(free), reserved: codec(reserved), frozen: codec(frozen) },
      }),
    },
    balances: {
      holds: jest.fn().mockResolvedValue(codec(holds)),
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
  __resetControllerCache();
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

  it('only samples every Nth block unless forced', async () => {
    setDerived({ free: BigInt(1) });
    setChain(P(999).toString(), '0', '0');

    await reconcile(9001); // 9001 % 2000 != 0 -> nothing queued
    expect(anomalies()).toHaveLength(0);

    await reconcile(8000); // 8000 % 2000 == 0
    expect(anomalies()).toHaveLength(1);
  });

  it('reconciles once per block, not after each event (no mid-block overshoot)', async () => {
    // a %2000 block; the derived balance is already correct once every event has been applied
    setDerived({ free: P(1000), reserved: P(200), total: P(1200) });
    setChain(P(1000).toString(), P(200).toString(), '0');

    await reconcileAccount(ADDR, '0000008000', block(8000), { eventIdx: 1 });
    await reconcileAccount(ADDR, '0000008000', block(8000), { eventIdx: 5 });
    await reconcileBlock();

    expect(anomalies()).toHaveLength(0);
    expect(db['AccountBalance'][ADDR]).toMatchObject({ free: P(1000), reserved: P(200) });
  });

  it('flushes nothing when nothing was queued (block handler runs every block)', async () => {
    setDerived({ free: BigInt(1) });
    setChain(P(999).toString(), '0', '0');

    await reconcileBlock(); // no reconcileAccount call first

    expect(anomalies()).toHaveLength(0);
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
