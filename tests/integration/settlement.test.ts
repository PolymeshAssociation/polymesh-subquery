import { gql } from "@apollo/client/core";
import { getApolloClient } from "../util";
const { query } = getApolloClient();

describe("settlements", () => {
  test("with no filter", async () => {
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

  test("with from filter", async () => {
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

  test("with ticker filter", async () => {
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

  test("with address filter", async () => {
    const q = {
      query: gql`
        query {
          settlements(
            filter: {
              addresses: {
                contains: ["5GKLEq7o3zZCGAeokuSoAMbmxamJ2uXJ984Fg8xYpaaWMUPr"]
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
