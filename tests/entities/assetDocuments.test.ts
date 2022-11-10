import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('assetDocuments', () => {
  it('should return all Asset Documents for a particular asset', async () => {
    const q = {
      query: gql`
        query {
          assetDocuments(filter: { assetId: { equalTo: "4TICKER" } }) {
            nodes {
              id: documentId
              ticker: assetId
              name
              link
              contentHash
              type
              filedAt
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
