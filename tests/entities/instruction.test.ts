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
              blockId
              status
              venueId
              settlementType
              addresses
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
                  ticker
                  amount
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
