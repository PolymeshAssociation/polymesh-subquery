import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('proposals', () => {
  it('should return proposals without filters', async () => {
    const q = {
      query: gql`
        query {
          proposals {
            totalCount
            nodes {
              id
              proposer
              ownerId
              state
              url
              description
              balance
              lastStateUpdatedAt: updatedBlockId
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

  it('should get proposal by id', async () => {
    const q = {
      query: gql`
        query {
          proposal(id: "1") {
            id
            proposer
            ownerId
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
  it('should return proposalVotes filtered by proposal ID', async () => {
    const q = {
      query: gql`
        query {
          proposalVotes(filter: { proposalId: { equalTo: "1" } }, orderBy: WEIGHT_DESC) {
            totalCount
            nodes {
              id
              createdBlockId
              weight
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
