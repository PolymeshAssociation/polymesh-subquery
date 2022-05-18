import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('accounts', () => {
  test('should return number of accounts associated with a given identity', async () => {
    const identityId = '0xc5ccde150ee81ea66cb9a7d49250ba6590087504322412bef75093b68134c59e';
    const res = await query({
      query: gql`
        query{
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

  test('should return just total count', async () => {
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

  test('should return first 10 accounts as there are no filters', async () => {
    const result = await query({
      query: gql`
        query {
          accounts(first: 10) {
            totalCount
            nodes {
              address
              identityId
              eventId
              permissionsId
              blockId
              datetime
            }
          }
        }
      `,
    });

    expect(result?.errors).toBeFalsy();

    expect(result?.data).toMatchSnapshot();
  });

  test('should return filtered accounts along with their permissions', async () => {
    const identityId = '0xc5ccde150ee81ea66cb9a7d49250ba6590087504322412bef75093b68134c59e';
    const result = await query({
      query: gql`
        query Accounts {
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
              blockId
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
  test('should return permissions for a given account address', async () => {
    const address = '5EYxLuFdbD99jn2BsZ3f1rMoa3raDB8TAnTLX3VMXhQoJyrv';
    const res = await query({
      query: gql`
      query Permissions {
        permissions(filter: { id: { equalTo: "${address}"}}) {
          nodes {
            nodeId
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

    expect(res?.data).toMatchSnapshot();
  });
});

describe('identities', () => {
  test('should return identity details along with accounts and their permissions', async () => {
    const identityId = '0x0200000000000000000000000000000000000000000000000000000000000001';
    const res = await query({
      query: gql`
      query IdentityDetails {
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
                blockId
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

  test('should return a list of identities whose secondary keys are frozen', async () => {
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
