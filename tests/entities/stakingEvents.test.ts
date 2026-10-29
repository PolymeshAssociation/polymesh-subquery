import { gql } from '@apollo/client/core';
import { expectQueryToMatchSnapshot } from '../util';

// blockId lessThan 1000 prevents staking events generated during the test form interfering with the results
describe('stakingEvents', () => {
  it('should return nomination events', () =>
    expectQueryToMatchSnapshot(gql`
      query {
        stakingEvents(filter: { eventId: { equalTo: Nominated } }, first: 10, orderBy: ID_ASC) {
          nodes {
            eventId
            datetime
            identityId
            stashId
            amount
            nominatedValidators
          }
          totalCount
        }
      }
    `));
  it('should filter by account', () =>
    expectQueryToMatchSnapshot(gql`
      query {
        stakingEvents(
          filter: { stashId: { equalTo: "5D9n9c1fCKa6uLf2aZHHFKk3oSPwuPTGvfnjgRbzptzownBH" } }
          first: 10
          orderBy: ID_ASC
        ) {
          nodes {
            eventId
            datetime
            identityId
            stashId
            amount
            nominatedValidators
          }
          totalCount
        }
      }
    `));
});
