import { gql } from '@apollo/client/core';
import { eveDid } from '../consts';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('instructions', () => {
  it('should return first 10 instructions', async () => {
    const q = {
      query: gql`
        query {
          instructions(first: 10, orderBy: ID_ASC) {
            totalCount
            nodes {
              createdBlockId
              legs(orderBy: ID_ASC) {
                nodes {
                  from
                  fromPortfolio
                  to
                  toPortfolio
                  assetId
                  amount
                  addresses
                }
              }
              status
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });

  it('should return instructions where a particular DID is involved', async () => {
    const q = {
      query: gql`
        query {
          legs(
            filter: {
              from: {
                equalTo: "${eveDid}"
              }
            }
            orderBy: ID_ASC
          ) {
            nodes {
              instruction {
                id
                createdBlockId
                status
                legs(orderBy: ID_ASC) {
                  nodes {
                    from
                    fromPortfolio
                    to
                    toPortfolio
                    assetId
                    amount
                    addresses
                  }
                }
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

  it('should return instructions for a particular Asset', async () => {
    const q = {
      query: gql`
        query {
          legs(filter: { assetId: { equalTo: "11BTICKER1" } }, orderBy: ID_ASC) {
            nodes {
              instruction {
                id
                createdBlockId
                status
                legs(orderBy: ID_ASC) {
                  nodes {
                    from
                    fromPortfolio
                    to
                    toPortfolio
                    assetId
                    amount
                    addresses
                  }
                }
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

  it('should return the instructions with address filter', async () => {
    const q = {
      query: gql`
        query {
          legs(
            filter: {
              addresses: { contains: ["5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"] }
            }
          ) {
            nodes {
              instruction {
                id
                createdBlockId
                status
                legs {
                  nodes {
                    from
                    fromPortfolio
                    to
                    toPortfolio
                    assetId
                    amount
                    addresses
                  }
                }
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
