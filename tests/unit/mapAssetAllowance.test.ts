/**
 * v8 asset allowances (defect G11). `handleApproval` upserts the remaining allowance;
 * `handleAllowanceSpent` takes the chain's own `remainingAllowance` rather than subtracting
 * `amountSpent`, so a missed or reordered event cannot accumulate drift.
 */

import { SubstrateEvent } from '@subql/types';
import { handleAllowanceSpent, handleApproval } from '../../src/mappings/entities/assets/mapAsset';

const ASSET = '0xasset0000000000000000000000000a';
const OWNER = '5Owner00000000000000000000000000000000000000000000';
const SPENDER = '5Spender000000000000000000000000000000000000000000';

const storeGet = (): jest.Mock => (globalThis as any).store.get as jest.Mock;
const storeSet = (): jest.Mock => (globalThis as any).store.set as jest.Mock;

const codec = (value: string) => ({ toString: () => value, toJSON: () => value });

const allowanceEvent = (method: 'Approval' | 'AllowanceSpent', values: string[]): SubstrateEvent =>
  ({
    idx: 0,
    block: {
      block: { header: { number: { toString: () => '800' } } },
      specVersion: 8000000,
      timestamp: new Date('2026-03-01T00:00:00Z'),
    },
    event: {
      section: 'asset',
      method,
      data: values.map(codec),
      meta: {
        fields: values.map(() => ({
          name: { isSome: false },
          typeName: { isSome: true, unwrap: () => codec('Dummy') },
        })),
      },
    },
  } as unknown as SubstrateEvent);

describe('asset allowances', () => {
  let db: Record<string, Record<string, any>>;

  beforeEach(() => {
    db = {
      Account: {
        [OWNER]: { id: OWNER, address: OWNER, identityId: '0x01' },
        [SPENDER]: { id: SPENDER, address: SPENDER, identityId: '0x02' },
      },
    };
    storeGet().mockImplementation((entity: string, id: string) =>
      Promise.resolve(db[entity]?.[id])
    );
    storeSet().mockImplementation((entity: string, id: string, data: any) => {
      (db[entity] ??= {})[id] = { ...data };
      return Promise.resolve();
    });
    (globalThis as any).api.query = {};
  });

  const id = `${ASSET}/${OWNER}/${SPENDER}`;

  it('handleApproval upserts the remaining allowance', async () => {
    await handleApproval(allowanceEvent('Approval', [OWNER, SPENDER, ASSET, '1000']));

    expect(db['AssetAllowance'][id]).toMatchObject({
      assetId: ASSET,
      ownerId: OWNER,
      spenderId: SPENDER,
      amount: BigInt(1000),
      totalSpent: BigInt(0),
    });

    await handleApproval(allowanceEvent('Approval', [OWNER, SPENDER, ASSET, '250']));
    expect(db['AssetAllowance'][id].amount).toBe(BigInt(250));
  });

  it('handleAllowanceSpent sets amount from remainingAllowance, not by subtraction', async () => {
    db['AssetAllowance'] = {
      [id]: {
        id,
        assetId: ASSET,
        ownerId: OWNER,
        spenderId: SPENDER,
        amount: BigInt(1000),
        totalSpent: BigInt(0),
      },
    };

    // amountSpent 300, but the chain reports remaining 690 (a 10-unit fee, say) — take 690, not 700
    await handleAllowanceSpent(
      allowanceEvent('AllowanceSpent', [OWNER, SPENDER, ASSET, '300', '690'])
    );

    expect(db['AssetAllowance'][id].amount).toBe(BigInt(690));
    expect(db['AssetAllowance'][id].totalSpent).toBe(BigInt(300));

    await handleAllowanceSpent(
      allowanceEvent('AllowanceSpent', [OWNER, SPENDER, ASSET, '90', '600'])
    );
    expect(db['AssetAllowance'][id].amount).toBe(BigInt(600));
    expect(db['AssetAllowance'][id].totalSpent).toBe(BigInt(390));
  });
});
