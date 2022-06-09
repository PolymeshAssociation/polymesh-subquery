import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('authorizations', () => {
  test('should return all authorizations', async () => {
    const q = {
      query: gql`
        query {
          authorizations(first: 100) {
            nodes {
              createdBlock
              authId
              type
              fromDid
              toDid
              toKey
              data
              expiry
              status
              updatedBlock
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();

    expect(subquery?.data).toMatchSnapshot();
  });
  test('should return authorisations filtered by authorization type', async () => {
    const q = {
      query: gql`
        query {
          authorizations(
            first: 100
            filter: { type: { in: ["BecomeAgent", "AddMultiSigSigner"] } }
          ) {
            nodes {
              createdBlock
              authId
              type
              fromDid
              toDid
              toKey
              data
              expiry
              status
              updatedBlock
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