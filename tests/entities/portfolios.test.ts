import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

const identityId = '0x73797374656d3a736574746c656d656e745f6d6f64756c655f64696400000000';
describe('portfolios', () => {
  it('should return all Portfolios for a particular identity', async () => {
    const q = {
      query: gql`
        query {
          portfolios(
            filter: {
              deletedAt: { isNull: true }
              identityId: {
                equalTo: "${identityId}"
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
              deletedAt: { isNull: true }
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
