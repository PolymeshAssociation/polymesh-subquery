/**
 * `StakingPosition.identity`, `AccountBalance.identity` and `Validator.identity` copy the account's
 * identity, so they follow it when the account joins or leaves one.
 */
import { restampIdentityCopies } from '../../src/utils/accounts';
import { mockStore } from './helpers';

const ADDRESS = '5C51bvAQho1tMPsNsxAQLkkFxV6Yj9NHGAtxhhxikpDF9qNX';
const DID = `0x${'95'.repeat(32)}`;

it("restamps the account's balance and staking position with its new identity", async () => {
  const db = mockStore({
    AccountBalance: { [ADDRESS]: { id: ADDRESS, identityId: undefined } },
    StakingPosition: { [ADDRESS]: { id: ADDRESS, identityId: undefined } },
  });

  await restampIdentityCopies(ADDRESS, DID, '0000000500/0000000001');

  expect(db.AccountBalance[ADDRESS]).toMatchObject({ identityId: DID });
  expect(db.StakingPosition[ADDRESS]).toMatchObject({ identityId: DID });
});

it('clears them when the account leaves its identity', async () => {
  const db = mockStore({
    AccountBalance: { [ADDRESS]: { id: ADDRESS, identityId: DID } },
  });

  await restampIdentityCopies(ADDRESS, undefined, '0000000500/0000000001');

  expect(db.AccountBalance[ADDRESS].identityId).toBeUndefined();
});

/** Mainnet stash 2EoZ98… moved identity at 8,974,035–8,974,083; its validator kept the old one */
it("moves a stash's validator to its new identity, permissioned as that identity is", async () => {
  const db = mockStore({
    Validator: {
      [ADDRESS]: { id: ADDRESS, identityId: `0x${'b5'.repeat(32)}`, isPermissioned: false },
    },
  });
  (globalThis as any).api.query = {
    staking: {
      permissionedIdentity: jest.fn((did: string) =>
        Promise.resolve({
          toJSON: () => (did === DID ? { intendedCount: 1, runningCount: 0 } : null),
        })
      ),
    },
  };

  await restampIdentityCopies(ADDRESS, DID, '0008974083/0000000001');

  expect(db.Validator[ADDRESS]).toMatchObject({
    identityId: DID,
    isPermissioned: true,
    updatedEventId: '0008974083/0000000001',
  });

  await restampIdentityCopies(ADDRESS, undefined, '0009000000/0000000001');

  expect(db.Validator[ADDRESS].identityId).toBeUndefined();
  expect(db.Validator[ADDRESS].isPermissioned).toBe(false);
});
