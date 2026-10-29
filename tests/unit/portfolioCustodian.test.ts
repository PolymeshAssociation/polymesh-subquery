/**
 * A portfolio's custodian is another identity holding custody; when custody returns to the owner the
 * chain removes the custodian entry, and the index records none.
 */
import { handlePortfolioCustodianChanged } from '../../src/mappings/entities/identities/mapPortfolio';
import { codec, mockStore, portfolioCodec, tupleEvent } from './helpers';

const OWNER = `0x${'01'.repeat(32)}`;
const CUSTODIAN = `0x${'02'.repeat(32)}`;
const ID = `${OWNER}/1`;

const changed = (custodian: string) =>
  tupleEvent({
    section: 'portfolio',
    method: 'PortfolioCustodianChanged',
    data: [codec(OWNER), portfolioCodec(OWNER, 1), codec(custodian)],
  });

it('records another identity as the custodian', async () => {
  const db = mockStore({ Portfolio: { [ID]: { id: ID, identityId: OWNER, number: 1 } } });

  await handlePortfolioCustodianChanged(changed(CUSTODIAN));

  expect(db.Portfolio[ID].custodianId).toBe(CUSTODIAN);
});

it('records no custodian once custody returns to the owner', async () => {
  const db = mockStore({
    Portfolio: { [ID]: { id: ID, identityId: OWNER, number: 1, custodianId: CUSTODIAN } },
  });

  await handlePortfolioCustodianChanged(changed(OWNER));

  expect(db.Portfolio[ID].custodianId).toBeNull();
});
