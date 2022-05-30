import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('compliances', () => {
  it('should return all compliance requirements for a particular asset', async () => {
    const q = {
      query: gql`
        query {
          compliances(filter: { assetId: { equalTo: "7TICKER" } }) {
            nodes {
              id: complianceId
              data
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
