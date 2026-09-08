/**
 * In-flight POLYX reconciliation (D11). Every Nth block for touched accounts, and always after a
 * `BalanceSet` / `DustLost`, the derived `AccountBalance` is checked against `system.account` at
 * the block being indexed. On a mismatch it records a `BalanceReconciliationDrift` anomaly and
 * corrects the derived value so the drift cannot compound.
 */

import { SubstrateBlock } from '@subql/types';
import { reconcileAccount } from '../../src/mappings/entities/identities/reconcilePolyx';

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
      updatedBlockId: '0',
      ...row,
    },
  };
};

const setChain = (free: string, reserved: string, frozen: string) => {
  (globalThis as any).api.query = {
    system: {
      account: jest
        .fn()
        .mockResolvedValue({
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
  db = {};
  storeGet().mockImplementation((entity: string, id: string) => Promise.resolve(db[entity]?.[id]));
  storeSet().mockImplementation((entity: string, id: string, data: any) => {
    (db[entity] ??= {})[id] = { ...data };
    return Promise.resolve();
  });
});

describe('reconcileAccount', () => {
  it('does nothing when the derived balance agrees with chain state', async () => {
    setDerived({ free: BigInt(1000), total: BigInt(1000), transferable: BigInt(1000) });
    setChain('1000', '0', '0');

    await reconcileAccount(ADDR, '0000009000', block(9000), { force: true });

    expect(anomalies()).toHaveLength(0);
  });

  it('records a drift anomaly and corrects each pool independently', async () => {
    setDerived({ free: BigInt(900), reserved: BigInt(100), total: BigInt(1000) });
    setChain('1000', '50', '0');

    await reconcileAccount(ADDR, '0000009000', block(9000), { force: true, eventIdx: 3 });

    expect(anomalies()).toHaveLength(1);
    expect(anomalies()[0]).toMatchObject({ kind: 'BalanceReconciliationDrift' });
    expect(anomalies()[0].detail).toContain('free 900 vs 1000');
    expect(anomalies()[0].detail).toContain('reserved 100 vs 50');

    expect(db['AccountBalance'][ADDR]).toMatchObject({
      free: BigInt(1000),
      reserved: BigInt(50),
      total: BigInt(1050),
    });
  });

  it('corrects frozen via a reconciled lock so it stays a MAX going forward', async () => {
    setDerived({ free: BigInt(1000), frozen: BigInt(0), transferable: BigInt(1000) });
    setChain('1000', '0', '400');

    await reconcileAccount(ADDR, '0000009000', block(9000), { force: true });

    expect(db['AccountBalance'][ADDR]).toMatchObject({
      frozen: BigInt(400),
      transferable: BigInt(600),
      locks: [{ lockId: 'reconciled', amount: BigInt(400), reasons: undefined }],
    });
  });

  it('only samples every Nth block unless forced', async () => {
    setDerived({ free: BigInt(1) });
    setChain('999', '0', '0');

    await reconcileAccount(ADDR, '0000009001', block(9001)); // 9001 % 500 != 0
    expect(anomalies()).toHaveLength(0);

    await reconcileAccount(ADDR, '0000009000', block(9000)); // 9000 % 500 == 0
    expect(anomalies()).toHaveLength(1);
  });
});
