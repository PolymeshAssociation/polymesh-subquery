import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('transferCompliances', () => {
  it('should return all transfer managers for a particular asset', async () => {
    const q = {
      query: gql`
        query {
          transferCompliances(
            first: 10
            filter: { assetId: { equalTo: "15TICKER" } }
            orderBy: ID_ASC
          ) {
            nodes {
              id
              ticker: assetId
              type
              value
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
