import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('instructions', () => {
  it('should return first 10 instructions', async () => {
    const q = {
      query: gql`
        query {
          instructions(first: 10) {
            totalCount
            nodes {
              createdBlockId
              status
              venueId
              settlementType
              legs {
                nodes {
                  from {
                    identityId
                    number
                  }
                  to {
                    identityId
                    number
                  }
                  assetId
                  amount
                  addresses
                }
              }
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
