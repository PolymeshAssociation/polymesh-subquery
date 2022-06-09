import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('trustedClaimIssuerTicker', () => {
  test('should return the trusted claim issuers for every ticker', async () => {
    const q = {
      query: gql`
        query {
          trustedClaimIssuerTickers {
            nodes {
              ticker
              issuer
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
