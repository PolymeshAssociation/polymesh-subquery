import { gql } from '@apollo/client/core';
import { notFoundDid } from '../consts';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('claimScopes', () => {
  it('should return an empty list as given identity has no claims', async () => {
    const identityId = notFoundDid;
    const res = await query({
      query: gql`
        query {
          claimScopes(
            filter: {
              target: {
                equalTo: "${identityId}"
              }
            }
          ) {
            nodes {
              scope
              ticker
            }
          }
        }
      `,
    });

    return expect(res?.data?.claimScopes?.nodes?.length).toEqual(0);
  });

  it('should return a list of scopes for a given ticker', async () => {
    const ticker = '5TICKER';
    const q = {
      query: gql`
      query {
        claimScopes(
          filter: {
            ticker: {
              equalTo: "${ticker}"
            }
          }
        ) {
          nodes {
            scope
            ticker
          }
        }
      }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();

    expect(subquery?.data).toMatchSnapshot();
  });
});

describe('claims', () => {
  it('should return no registries as given identity has no claims', async () => {
    const identityId = notFoundDid;
    const res = await query({
      query: gql`
        query{
          claims(filter: {
              targetId: {
                in: ["${identityId}"]
              }
            }) {
            totalCount
          }
        }
      `,
    });

    return expect(res?.data?.claims?.totalCount).toEqual(0);
  });

  it('should return just total count', async () => {
    const res = await query({
      query: gql`
        query {
          claims {
            totalCount
          }
        }
      `,
    });

    expect(res?.data).toMatchSnapshot();
  });

  it('should return all claims as there are no filters', async () => {
    const q = {
      query: gql`
        query {
          claims(first: 10, orderBy: ID_ASC) {
            totalCount
            nodes {
              targetId
              issuerId
              issuanceDate
              lastUpdateDate
              expiry
              filterExpiry
              type
              jurisdiction
              scope
              cddId
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();

    expect(subquery?.data).toMatchSnapshot();
  });

  it('should return filtered claims', async () => {
    const scopeType = 'Identity';
    const scopeValue = '5TICKER';
    const trustedClaimIssuer = '0x56a91c10f2368b30670b7bea260928f0291387abfb75b5953cd722917423bf01';
    const q = {
      variables: { scopeValue },
      query: gql`
        query q($scopeValue: String!){
          claims(filter: {
            scope: {
              equalTo: {
                type: ${scopeType},
                value: $scopeValue
              }
            },
            issuerId: {
              equalTo: "${trustedClaimIssuer}"
            }
          }, orderBy: ID_ASC) {
            totalCount
            nodes {
              targetId
              issuerId
              issuanceDate
              lastUpdateDate
              expiry
              filterExpiry
              type
              jurisdiction
              scope
              cddId
            }
          }
        }
      `,
    };
    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();

    expect(subquery?.data).toMatchSnapshot();
  });
});
