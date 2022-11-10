import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('portfolioMovements', () => {
  it('should return all movements associated with a particular Portfolio', async () => {
    const q = {
      query: gql`
        query {
          portfolioMovements(
            filter: {
              fromId: {
                equalTo: "0xc5e2d554233da63d509ee482dbeed0ddec94dc1d0b45ebfdcdc48bd0928222b1/1"
              }
            }
          ) {
            nodes {
              nodeId
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
    const q = {
      query: gql`
        query {
          portfolioMovements(
            filter: {
              fromId: {
                startsWith: "0xc5e2d554233da63d509ee482dbeed0ddec94dc1d0b45ebfdcdc48bd0928222b1/"
              }
            }
          ) {
            nodes {
              nodeId
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
