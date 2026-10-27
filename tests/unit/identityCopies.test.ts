/**
 * `AccountBalance.identity` copies the account's identity, so it follows it when the account joins
 * or leaves one.
 */
import { restampIdentityCopies } from '../../src/utils/accounts';
import { mockStore } from './helpers';

const ADDRESS = '5C51bvAQho1tMPsNsxAQLkkFxV6Yj9NHGAtxhhxikpDF9qNX';
const DID = `0x${'95'.repeat(32)}`;

it("restamps the account's balance with its new identity", async () => {
  const db = mockStore({
    AccountBalance: { [ADDRESS]: { id: ADDRESS, identityId: undefined } },
  });

  await restampIdentityCopies(ADDRESS, DID, '0000000500/0000000001');

  expect(db.AccountBalance[ADDRESS]).toMatchObject({ identityId: DID });
});

it('clears them when the account leaves its identity', async () => {
  const db = mockStore({
    AccountBalance: { [ADDRESS]: { id: ADDRESS, identityId: DID } },
  });

  await restampIdentityCopies(ADDRESS, undefined, '0000000500/0000000001');

  expect(db.AccountBalance[ADDRESS].identityId).toBeUndefined();
});
