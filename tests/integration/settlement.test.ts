import { gql } from "@apollo/client/core";
import { getApolloClient } from "../util";
const { query } = getApolloClient();

describe("getSettlements", () => {
  test("test getting settlements", async () => {
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

  test("test getting settlements with from filter", async () => {
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
});
