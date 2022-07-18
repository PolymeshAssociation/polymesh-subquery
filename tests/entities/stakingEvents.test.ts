import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

// blockId lessThan 1000 prevents staking events generated during the test form interfering with the results
describe('stakingEvents', () => {
  it('should return nomination events', async () => {
    const q = {
      query: gql`
        query {
          stakingEvents(filter: { eventId: { equalTo: Nominated } }, first: 10) {
            nodes {
              eventId
              datetime
              identityId
              stashAccount
              amount
              nominatedValidators
            }
            totalCount
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });
  it('should filter by account', async () => {
    const q = {
      query: gql`
        query {
          stakingEvents(
            filter: {
              stashAccount: {
                equalTo: "0x301ae89b2d71df51a78bfa5700385a7612bd34cf0a482407eccdafc17ef75121"
              }
            }
            first: 10
          ) {
            nodes {
              eventId
              datetime
              identityId
              stashAccount
              amount
              nominatedValidators
            }
            totalCount
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });
});
