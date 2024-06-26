import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('authorizations', () => {
  it('should return all authorizations', async () => {
    const q = {
      query: gql`
        query {
          authorizations(first: 100, orderBy: ID_ASC) {
            nodes {
              authId: id
              type
              fromDid: fromId
              toDid: toId
              toKey
              data
              expiry
              status
              createdBlockId
              updatedBlockId
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();

    expect(subquery?.data).toMatchSnapshot();
  });
  it('should return authorizations filtered by authorization type', async () => {
    const q = {
      query: gql`
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
              toKey
              data
              expiry
              status
              createdBlockId
              updatedBlockId
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
