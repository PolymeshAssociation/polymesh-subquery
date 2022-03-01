import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('proposals', () => {
  test('without filters', async () => {
    const q = {
      query: gql`
        query {
          proposals {
            totalCount
            nodes {
              id
              proposer
              identityId
              state
              url
              description
              balance
              lastStateUpdatedAt
              yay: votes(filter: { vote: { equalTo: true } }) {
                totalCount
              }
              totalAyeWeight
              nay: votes(filter: { vote: { equalTo: false } }) {
                totalCount
              }
              totalNayWeight
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();

    expect(subquery?.data).toMatchSnapshot();
  });

  test('get by id', async () => {
    const q = {
      query: gql`
        query {
          proposal(id: "1") {
            id
            proposer
            identityId
            state
            url
            description
            balance
            votes {
              totalCount
              nodes {
                weight
                account
                vote
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

describe('proposalVotes', () => {
  test('votes for a proposal ID', async () => {
    const q = {
      query: gql`
        query {
          proposalVotes(filter: { proposalId: { equalTo: "1" } }, orderBy: WEIGHT_DESC) {
            totalCount
            nodes {
              id
              blockId
              weight
              eventIdx
              account
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
