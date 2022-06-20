import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('settlements', () => {
  it('should return first 10 settlements', async () => {
    const q = {
      query: gql`
        query {
          settlements(first: 10) {
            totalCount
            nodes {
              createdBlockId
              legs {
                nodes {
                  from {
                    identityId
                    number
                  }
                  to {
                    identityId
                    number
                  }
                  assetId
                  amount
                  addresses
                }
              }
              result
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });

  it('should return settlements where a particular DID is involved', async () => {
    const q = {
      query: gql`
        query {
          legs(
            filter: {
              fromId: {
                startsWith: "0x0500000000000000000000000000000000000000000000000000000000000000/"
              }
            }
          ) {
            nodes {
              settlement {
                id
                createdBlockId
                result
                legs {
                  nodes {
                    from {
                      identityId
                      number
                    }
                    to {
                      identityId
                      number
                    }
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

  it('should return settlements for a particular Asset', async () => {
    const q = {
      query: gql`
        query {
          legs(filter: { assetId: { equalTo: "11BTICKER1" } }) {
            nodes {
              settlement {
                id
                createdBlockId
                result
                legs {
                  nodes {
                    from {
                      identityId
                      number
                    }
                    to {
                      identityId
                      number
                    }
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

  it('should return the settlements with address filter', async () => {
    const q = {
      query: gql`
        query {
          legs(
            filter: {
              addresses: {
                contains: ["0x6cd2229cfcefc94ca4fa6e0596576d4d3bdbba6147647570f07b99cf16bbb56e"]
              }
            }
          ) {
            nodes {
              settlement {
                id
                createdBlockId
                result
                legs {
                  nodes {
                    from {
                      identityId
                      number
                    }
                    to {
                      identityId
                      number
                    }
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
