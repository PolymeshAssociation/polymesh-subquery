import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

const identityId = '0xa05d9333759c804fbab61d454f6317c1a8257c01c49c68e029a112f9123e9c0b';
describe('accounts', () => {
  it('should return number of accounts associated with a given identity', async () => {
    const res = await query({
      query: gql`
        query {
          accounts(filter: {
              identityId: {
                equalTo: "${identityId}"
              }
            }) {
            totalCount
          }
        }
      `,
    });

    return expect(res?.data?.accounts?.totalCount).toEqual(2);
  });

  it('should return just total count', async () => {
    const res = await query({
      query: gql`
        query {
          accounts {
            totalCount
          }
        }
      `,
    });

    expect(res?.data).toMatchSnapshot();
  });

  it('should return first 10 accounts as there are no filters', async () => {
    const result = await query({
      query: gql`
        query {
          accounts(first: 10, orderBy: ID_ASC) {
            totalCount
            nodes {
              address
              identityId
              keyRole
              eventId
              createdBlockId
              datetime
            }
          }
        }
      `,
    });

    expect(result?.errors).toBeFalsy();

    expect(result?.data).toMatchSnapshot();
  });

  it('should return filtered accounts along with their key assignments and permissions', async () => {
    const result = await query({
      query: gql`
        query {
          accounts(
            filter: {
              identityId: {
                equalTo: "${identityId}"
              }
            }
            orderBy: ID_ASC
          ) {
            nodes {
              id
              address
              identityId
              keyRole
              eventId
              createdBlockId
              datetime
              identity {
                did
                primaryAccount
                secondaryKeysFrozen
              }
              keyAssignments(orderBy: [VALID_FROM_BLOCK_ID_ASC]) {
                nodes {
                  role
                  validFromBlockId
                  validToBlockId
                  addedReason
                  permissions
                }
              }
            }
          }
        }
      `,
    });

    expect(result?.errors).toBeFalsy();

    expect(result?.data).toMatchSnapshot();
  });
});

describe('identityKeys', () => {
  it("returns a key's permissions on the IdentityKey row (the Permissions entity is gone, G4)", async () => {
    const address = '5EYxLuFdbD99jn2BsZ3f1rMoa3raDB8TAnTLX3VMXhQoJyrv';
    const res = await query({
      query: gql`
      query {
        identityKeys(filter: { accountId: { equalTo: "${address}" } }, orderBy: VALID_FROM_BLOCK_ID_ASC) {
          nodes {
            id
            identityId
            role
            permissions
            validFromBlockId
            validToBlockId
            addedReason
            removedReason
          }
        }
      }
      `,
    });

    expect(res?.errors).toBeFalsy();

    expect(res?.data).toMatchSnapshot();
  });
});

describe('identities', () => {
  it('lists current secondary keys via IdentityKey without the primary key (G1)', async () => {
    const res = await query({
      query: gql`
      query {
        identities(
          filter: {
            did: {
              equalTo: "${identityId}"
            }
          }
        ) {
          nodes {
            did
            primaryAccount
            secondaryKeysFrozen
            eventId
            createdBlockId
            updatedBlockId
            datetime
            keys(
              filter: { role: { equalTo: Secondary }, validToBlockId: { isNull: true } }
              orderBy: [ACCOUNT_ID_ASC]
            ) {
              nodes {
                role
                addedReason
                validToBlockId
                account {
                  address
                  eventId
                  createdBlockId
                }
                permissions
              }
            }
          }
        }
      }
      `,
    });

    expect(res?.errors).toBeFalsy();

    const [identity] = (res?.data as any).identities.nodes;
    const keys = identity.keys.nodes;

    // every returned membership is an active secondary key...
    expect(keys.every((k: any) => k.role === 'Secondary')).toBe(true);
    expect(keys.every((k: any) => k.validToBlockId === null)).toBe(true);
    // ...and the primary key is never among them — the G1 regression
    expect(keys.some((k: any) => k.account.address === identity.primaryAccount)).toBe(false);

    expect(res?.data).toMatchSnapshot();
  });

  it('should return a list of identities whose secondary keys are frozen', async () => {
    const result = await query({
      query: gql`
        query {
          identities(filter: { secondaryKeysFrozen: { equalTo: true } }, orderBy: ID_ASC) {
            nodes {
              did
            }
          }
        }
      `,
    });

    expect(result?.errors).toBeFalsy();

    expect(result?.data?.identities?.nodes?.length).toEqual(0);
  });
});
