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
              eventId
              permissionsId
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

  it('should return filtered accounts along with their permissions', async () => {
    const result = await query({
      query: gql`
        query {
          accounts(
            filter: {
              identityId: {
                equalTo: "${identityId}"
              }
            }
          ) {
            nodes {
              id
              address
              identityId
              eventId
              permissionsId
              createdBlockId
              datetime
              identity {
                did
                primaryAccount
                secondaryKeysFrozen
              }
              permissions {
                assets
                portfolios
                transactions
                transactionGroups
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

describe('permissions', () => {
  it('should return permissions for a given account address', async () => {
    const address = '5EYxLuFdbD99jn2BsZ3f1rMoa3raDB8TAnTLX3VMXhQoJyrv';
    const res = await query({
      query: gql`
      query {
        permissions(filter: { id: { equalTo: "${address}"}}, orderBy: ID_ASC) {
          nodes {
            id
            assets
            portfolios
            transactions
            transactionGroups
            createdBlockId
            updatedBlockId
            datetime
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
  it('should return identity details along with accounts and their permissions', async () => {
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
            createdBlockId
            updatedBlockId
            secondaryAccounts(orderBy: [ADDRESS_ASC]) {
              nodes {
                address
                eventId
                createdBlockId
                permissions {
                  assets
                  portfolios
                  transactions
                  transactionGroups
                  createdBlockId
                  updatedBlockId
                  datetime
                }
              }
            }
          }
        }
      }
      `,
    });

    expect(res?.errors).toBeFalsy();

    expect(res?.data).toMatchSnapshot();
  });

  it('should return a list of identities whose secondary keys are frozen', async () => {
    const result = await query({
      query: gql`
        query {
          identities(filter: { secondaryKeysFrozen: { equalTo: true } }) {
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
