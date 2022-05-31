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
              blockId
              addresses
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
                  ticker
                  amount
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
                blockId
                addresses
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
                    ticker
                    amount
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

  it('should return settlements for a particular ticker', async () => {
    const q = {
      query: gql`
        query {
          legs(filter: { ticker: { equalTo: "4TICKER" } }) {
            nodes {
              settlement {
                id
                blockId
                addresses
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
                    ticker
                    amount
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
          settlements(
            filter: {
              addresses: {
                contains: ["0xbc18d7b0241882bcfc94b5fe0d520988f2a9f4050a2a1df58c4de14ee23f3915"]
              }
            }
          ) {
            totalCount
            nodes {
              id
              blockId
              addresses
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
                  ticker
                  amount
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
