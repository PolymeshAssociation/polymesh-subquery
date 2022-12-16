import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
import { eveDid } from '../consts';
const { query } = getApolloClient();

describe('assetHolders', () => {
  it('should return all Asset Holders for a particular ticker', async () => {
    const q = {
      query: gql`
        query {
          assetHolders(filter: { assetId: { equalTo: "11BTICKER1" } }) {
            nodes {
              id
              did: identityId
              ticker: assetId
              amount
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });

  it('should return all Assets held by an Identity', async () => {
    const q = {
      query: gql`
        query {
          assetHolders(
            filter: {
              identityId: {
                equalTo: "${eveDid}"
              }
            }
          ) {
            nodes {
              ticker: assetId
              amount
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });

  it('should return amount of Assets held by a particular Identity', async () => {
    const q = {
      query: gql`
        query {
          assetHolders(
            filter: {
              identityId: {
                equalTo: "${eveDid}"
              }
              assetId: { equalTo: "11BTICKER1" }
            }
          ) {
            nodes {
              amount
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
