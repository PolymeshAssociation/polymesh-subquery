/**
 * v8 asset allowances (defect G11). `handleApproval` upserts the remaining allowance;
 * `handleAllowanceSpent` takes the chain's own `remainingAllowance` rather than subtracting
 * `amountSpent`, so a missed or reordered event cannot accumulate drift.
 */

import { SubstrateEvent } from '@subql/types';
import { handleAllowanceSpent, handleApproval } from '../../src/mappings/entities/assets/mapAsset';
import { codec, MockDb, mockStore, tupleEvent } from './helpers';

const ASSET = '0xasset0000000000000000000000000a';
const OWNER = '5Owner00000000000000000000000000000000000000000000';
const SPENDER = '5Spender000000000000000000000000000000000000000000';

const allowanceEvent = (method: 'Approval' | 'AllowanceSpent', values: string[]) =>
  tupleEvent({ section: 'asset', method, data: values.map(v => codec(v)), blockNumber: '800' });

/**
 * The same event as a struct-style one, the shape a later v8 testnet runtime turned out to emit:
 * metadata names every field, in idiomatic-Rust snake_case (`asset_id`, not `assetId`) — the
 * defect this test guards (block 25,557,789, `asset.Approval`: "has no field \"assetId\"; it
 * carries [owner, spender, asset_id, amount]").
 */
const namedAllowanceEvent = (
  method: 'Approval' | 'AllowanceSpent',
  fields: Record<string, string>
): SubstrateEvent =>
  ({
    idx: 2,
    block: {
      block: { header: { number: { toString: () => '800' } } },
      specVersion: 8_000_000,
      timestamp: new Date('2026-01-01T00:00:00Z'),
      events: [],
    },
    event: {
      section: 'asset',
      method,
      data: Object.values(fields).map(v => codec(v)),
      meta: {
        fields: Object.keys(fields).map(name => ({
          name: { isSome: true, unwrap: () => codec(name) },
          typeName: { isSome: true, unwrap: () => codec('Dummy') },
        })),
      },
    },
  } as unknown as SubstrateEvent);

describe('asset allowances', () => {
  let db: MockDb;

  beforeEach(() => {
    db = mockStore({
      Account: {
        [OWNER]: { id: OWNER, address: OWNER, identityId: '0x01' },
        [SPENDER]: { id: SPENDER, address: SPENDER, identityId: '0x02' },
      },
    });
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

  it('handleApproval resolves the same fields when the runtime names asset_id in snake_case', async () => {
    await handleApproval(
      namedAllowanceEvent('Approval', {
        owner: OWNER,
        spender: SPENDER,
        asset_id: ASSET,
        amount: '1000',
      })
    );

    expect(db['AssetAllowance'][id]).toMatchObject({
      assetId: ASSET,
      ownerId: OWNER,
      spenderId: SPENDER,
      amount: BigInt(1000),
    });
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
