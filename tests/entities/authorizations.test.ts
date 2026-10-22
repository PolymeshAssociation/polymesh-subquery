import { gql } from '@apollo/client/core';
import { expectQueryToMatchSnapshot } from '../util';

describe('authorizations', () => {
  it('should return all authorizations', () =>
    expectQueryToMatchSnapshot(gql`
      query {
        authorizations(first: 100, orderBy: ID_ASC) {
          nodes {
            authId: id
            type
            fromDid: fromId
            toDid: toId
            toAccountId
            data
            expiry
            status
            createdBlockId
            updatedBlockId
          }
        }
      }
    `));
  it('should return authorizations filtered by authorization type', () =>
    expectQueryToMatchSnapshot(gql`
      query {
        authorizations(
          first: 100
          filter: { type: { in: [BecomeAgent, AddMultiSigSigner] } }
          orderBy: ID_ASC
        ) {
          nodes {
            authId: id
            type
            fromDid: fromId
            toDid: toId
            toAccountId
            data
            expiry
            status
            createdBlockId
            updatedBlockId
          }
        }
      }
    `));
});
