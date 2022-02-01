import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('settlements', () => {
  test('with no filter', async () => {
    const q = {
      query: gql`
        query {
          settlements(first: 10) {
            totalCount
            nodes {
              blockId
              addresses
              legs
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

  test('with from filter', async () => {
    const q = {
      query: gql`
        query {
          settlements(
            filter: {
              legs: {
                contains: [
                  {
                    from: {
                      did: "0x0500000000000000000000000000000000000000000000000000000000000000"
                    }
                  }
                ]
              }
            }
          ) {
            totalCount
            nodes {
              id
              blockId
              legs
              addresses
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });

  test('with ticker filter', async () => {
    const q = {
      query: gql`
        query {
          settlements(filter: { legs: { contains: [{ ticker: "4TICKER" }] } }) {
            totalCount
            nodes {
              id
              blockId
              legs
              addresses
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });

  test('with address filter', async () => {
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
              legs
              addresses
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
