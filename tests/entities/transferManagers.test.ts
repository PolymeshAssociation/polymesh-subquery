import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('transferManagers', () => {
  it('should return all transfer managers for a particular asset', async () => {
    const q = {
      query: gql`
        query {
          transferManagers(first: 10, filter: { assetId: { equalTo: "15TICKER" } }) {
            nodes {
              id
              ticker: assetId
              type
              value
              exemptedEntities
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
