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

  test("test getting settlements with filters", async () => {
    const q = {
      query: gql`
        query {
          query {
            portfolios(filter: { name: { likeInsensitive: "4_portfolio" } }) {
              totalCount
              nodes {
                id
                identityId
                kind
                number
                name
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
