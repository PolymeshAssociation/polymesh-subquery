import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('portfolioMovements', () => {
  let fromId: string;

  beforeEach(async () => {
    const q = {
      query: gql`
        query {
          portfolioMovements(first: 1, orderBy: ID_ASC) {
            nodes {
              fromId
            }
          }
        }
      `,
    };
    const result = await query(q);

    fromId = result.data.portfolioMovements.nodes[0].fromId;
  });
  it('should return all movements associated with a particular Portfolio', async () => {
    const q = {
      query: gql`
        query {
          portfolioMovements(
            filter: {
              fromId: {
                equalTo: "${fromId}"
              }
            }, orderBy: ID_ASC
          ) {
            nodes {
              id
              fromId
              toId
              assetId
              amount
              address
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });

  it('should return all Portfolio movements associated with a particular Identity', async () => {
    const fromDid = fromId.split('/')[0];
    const q = {
      query: gql`
        query {
          portfolioMovements(
            filter: {
              fromId: {
                startsWith: "${fromDid}"
              }
            }, orderBy: ID_ASC
          ) {
            nodes {
              id
              fromId
              toId
              assetId
              amount
              address
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
