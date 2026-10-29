import { gql } from '@apollo/client/core';
import { expectQueryToMatchSnapshot } from '../util';

describe('proposals', () => {
  it('should return proposals without filters', () =>
    expectQueryToMatchSnapshot(gql`
      query {
        proposals(orderBy: ID_ASC) {
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
    `));

  it('should get proposal by id', () =>
    expectQueryToMatchSnapshot(gql`
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
    `));
});

describe('proposalVotes', () => {
  it('should return proposalVotes filtered by proposal ID', () =>
    expectQueryToMatchSnapshot(gql`
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
    `));
});
