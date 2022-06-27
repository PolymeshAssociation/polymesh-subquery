import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('tickerExternalAgentHistory', () => {
  it('should return history of each external agent in ticker', async () => {
    const q = {
      variables: { ticker: '12TICKER' },
      query: gql`
        query q($ticker: String!) {
          tickerExternalAgentHistories(filter: { assetId: { equalTo: $ticker } }) {
            nodes {
              ticker: assetId
              did: identityId
              createdBlockId
              eventIdx
              datetime
              type
              permissions
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
