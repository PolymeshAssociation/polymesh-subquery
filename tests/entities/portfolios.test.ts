import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('portfolios', () => {
  it('should return all Portfolios for a particular identity', async () => {
    const q = {
      query: gql`
        query {
          portfolios(
            filter: {
              identityId: {
                equalTo: "0xc5e2d554233da63d509ee482dbeed0ddec94dc1d0b45ebfdcdc48bd0928222b1"
              }
            }
          ) {
            nodes {
              nodeId
              id
              identityId
              number
              name
              custodianId
              createdBlockId
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });

  it('should return all numbered Portfolio held by an Identity', async () => {
    const q = {
      query: gql`
        query {
          portfolios(
            filter: {
              identityId: {
                equalTo: "0xc5e2d554233da63d509ee482dbeed0ddec94dc1d0b45ebfdcdc48bd0928222b1"
              }
              number: { greaterThan: 0 }
            }
          ) {
            nodes {
              nodeId
              id
              identityId
              number
              name
              custodianId
              createdBlockId
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
