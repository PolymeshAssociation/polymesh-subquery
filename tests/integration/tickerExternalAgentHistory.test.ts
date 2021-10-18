import { gql } from "@apollo/client/core";
import { getApolloClient } from "../util";
const { query } = getApolloClient();

describe("tickerExternalAgentHistory", () => {
  test("should return history of each external agent in ticker", async () => {
    const q = {
      variables: { ticker: "12TICKER" },
      query: gql`
        query q($ticker: String!) {
          tickerExternalAgentHistories(
            filter: { ticker: { equalTo: $ticker } }
          ) {
            nodes {
              ticker
              did
              blockId
              eventIdx
              datetime
              type
              permissions
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
