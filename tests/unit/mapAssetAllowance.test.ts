/**
 * v8 asset allowances (defect G11). `handleApproval` upserts the remaining allowance;
 * `handleAllowanceSpent` takes the chain's own `remainingAllowance` rather than subtracting
 * `amountSpent`, so a missed or reordered event cannot accumulate drift.
 */

import { handleAllowanceSpent, handleApproval } from '../../src/mappings/entities/assets/mapAsset';
import { codec, MockDb, mockStore, tupleEvent } from './helpers';

const ASSET = '0xasset0000000000000000000000000a';
const OWNER = '5Owner00000000000000000000000000000000000000000000';
const SPENDER = '5Spender000000000000000000000000000000000000000000';

const allowanceEvent = (method: 'Approval' | 'AllowanceSpent', values: string[]) =>
  tupleEvent({ section: 'asset', method, data: values.map(v => codec(v)), blockNumber: '800' });

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
