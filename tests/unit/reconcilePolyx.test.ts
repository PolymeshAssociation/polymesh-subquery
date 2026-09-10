/**
 * In-flight POLYX reconciliation (D11). Every Nth block for touched accounts, and always after a
 * `BalanceSet` / `DustLost`, the derived `AccountBalance` is checked against `system.account` at
 * the block being indexed. On a mismatch it records a `BalanceReconciliationDrift` anomaly and
 * corrects the derived value so the drift cannot compound.
 */

import { SubstrateBlock } from '@subql/types';
import {
  __resetOnChainCache,
  reconcileAccount,
} from '../../src/mappings/entities/identities/reconcilePolyx';

const ADDR = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

const storeGet = (): jest.Mock => (globalThis as any).store.get as jest.Mock;
const storeSet = (): jest.Mock => (globalThis as any).store.set as jest.Mock;

const codec = (v: string) => ({ toString: () => v });

const block = (height: number): SubstrateBlock =>
  ({
    block: { header: { number: { toString: () => String(height) } } },
    timestamp: new Date('2024-01-01T00:00:00Z'),
    specVersion: 8_000_000,
  } as unknown as SubstrateBlock);

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

const setChain = (free: string, reserved: string, frozen: string) => {
  (globalThis as any).api.query = {
    system: {
      account: jest.fn().mockResolvedValue({
        data: { free: codec(free), reserved: codec(reserved), frozen: codec(frozen) },
      }),
    },
  };
};

const anomalies = () =>
  storeSet()
    .mock.calls.filter(([e]) => e === 'IndexerAnomaly')
    .map(([, , row]) => row);

beforeEach(() => {
  __resetOnChainCache();
  db = {};
  storeGet().mockImplementation((entity: string, id: string) => Promise.resolve(db[entity]?.[id]));
  storeSet().mockImplementation((entity: string, id: string, data: any) => {
    (db[entity] ??= {})[id] = { ...data };
    return Promise.resolve();
  });
});

// Values are in base units (6 decimals); drifts here are far above the MIN_DRIFT (100 POLYX) floor.
const P = (polyx: number): bigint => BigInt(polyx) * BigInt(1_000_000);

describe('reconcileAccount', () => {
  it('does nothing when the derived balance agrees with chain state', async () => {
    setDerived({ free: P(1000), total: P(1000), transferable: P(1000) });
    setChain(P(1000).toString(), '0', '0');

    await reconcileAccount(ADDR, '0000009000', block(9000), { force: true });

    expect(anomalies()).toHaveLength(0);
  });

  it('ignores sub-100-POLYX drift (weight-fee gap / mid-block sample noise)', async () => {
    setDerived({ free: P(1000) + BigInt(50_000_000), total: P(1000) });
    setChain(P(1000).toString(), '0', '0');

    await reconcileAccount(ADDR, '0000009000', block(9000), { force: true });

    expect(anomalies()).toHaveLength(0);
  });

  it('records a drift anomaly and corrects each pool independently', async () => {
    setDerived({ free: P(900), reserved: P(100), total: P(1000) });
    setChain(P(1000).toString(), P(50).toString(), '0');

    await reconcileAccount(ADDR, '0000009000', block(9000), { force: true, eventIdx: 3 });

    expect(anomalies()).toHaveLength(1);
    expect(anomalies()[0]).toMatchObject({ kind: 'BalanceReconciliationDrift' });
    expect(anomalies()[0].detail).toContain(`free ${P(900)} vs ${P(1000)}`);

    expect(db['AccountBalance'][ADDR]).toMatchObject({
      free: P(1000),
      reserved: P(50),
      total: P(1050),
    });
  });

  it('corrects frozen by pinning the staking lock, so later staking events adjust a real base', async () => {
    setDerived({ free: P(1000), frozen: BigInt(0), transferable: P(1000) });
    setChain(P(1000).toString(), '0', P(400).toString());

    await reconcileAccount(ADDR, '0000009000', block(9000), { force: true });

    expect(db['AccountBalance'][ADDR]).toMatchObject({
      frozen: P(400),
      transferable: P(600),
      locks: [{ lockId: 'staking ', amount: P(400), reasons: 'staking' }],
    });
  });

  it('only samples every Nth block unless forced', async () => {
    setDerived({ free: BigInt(1) });
    setChain(P(999).toString(), '0', '0');

    await reconcileAccount(ADDR, '0000009001', block(9001)); // 9001 % 2000 != 0
    expect(anomalies()).toHaveLength(0);

    await reconcileAccount(ADDR, '0000008000', block(8000)); // 8000 % 2000 == 0
    expect(anomalies()).toHaveLength(1);
  });
});
