import { upsertAccount } from '../../src/utils/accounts';
import { AccountKeyRole } from '../../src/types';
import { mockLedgerAccountQuery, mockStore } from './helpers';

const STASH = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const DID_B = '0x0b'.padEnd(66, '0');

/**
 * `StakingPosition.identity` is a copy of the stash account's identity, so it has to follow the
 * account: a stash can leave one identity and join another while it stays bonded. The copy is
 * updated where the account changes, not re-read on every staking event.
 */
describe("a staking position follows its stash's identity", () => {
  beforeEach(() => {
    mockLedgerAccountQuery();
  });

  it('moves to the identity the stash is linked to', async () => {
    const db = mockStore({
      Account: { [STASH]: { id: STASH, address: STASH, identityId: TEST_DID } },
      StakingPosition: { [STASH]: { id: STASH, stashId: STASH, identityId: TEST_DID } },
    });

    await upsertAccount(
      { address: STASH, identityId: DID_B, keyRole: AccountKeyRole.PrimaryKey } as never,
      '0000002000/0000000001'
    );

    expect(db.StakingPosition[STASH]).toMatchObject({
      identityId: DID_B,
      updatedEventId: '0000002000/0000000001',
    });
  });

  it('is left alone when the identity did not change', async () => {
    const db = mockStore({
      Account: { [STASH]: { id: STASH, address: STASH, identityId: TEST_DID } },
      StakingPosition: {
        [STASH]: { id: STASH, stashId: STASH, identityId: TEST_DID, updatedEventId: 'earlier' },
      },
    });

    await upsertAccount(
      { address: STASH, identityId: TEST_DID, keyRole: AccountKeyRole.PrimaryKey } as never,
      '0000002000/0000000001'
    );

    expect(db.StakingPosition[STASH].updatedEventId).toBe('earlier');
  });
});
