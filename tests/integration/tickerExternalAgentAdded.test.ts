import { gql } from "@apollo/client/core";
import { getApolloClient } from "../util";
const { query } = getApolloClient();

describe("tickerExternalAgentAdded", () => {
  test("should return the time block and event index when an agent was added to a ticker", async () => {
    const q = {
      variables: { ticker: "12TICKER" },
      query: gql`
        query q($ticker: String!) {
          tickerExternalAgentAddeds(
            filter: {
              ticker: { equalTo: $ticker }
              callerDid: {
                equalTo: "0x0854afeca045161ef42ba9be94c973f65efc0e8532933500865a1fd655148f6c"
              }
            }
          ) {
            nodes {
              callerDid
              datetime
              blockId
              eventIdx
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });
  test("should return empty when an agent has been removed", async () => {
    const q = {
      variables: { ticker: "12TICKER" },
      query: gql`
        query q($ticker: String!) {
          tickerExternalAgentAddeds(
            filter: {
              ticker: { equalTo: $ticker }
              callerDid: {
                equalTo: "0xeb686d5391c1123fcd252419bc1e77b525f46bddc8964d34e74be0988c419fea"
              }
            }
          ) {
            nodes {
              datetime
              blockId
              eventIdx
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data?.tickerExternalAgentAddeds.nodes).toEqual([]);
  });
  test("should return empty when the agent is not found", async () => {
    const res = await query({
      variables: { ticker: "12TICKER" },
      query: gql`
        query q($ticker: String!) {
          tickerExternalAgentAddeds(
            filter: {
              ticker: { equalTo: $ticker }
              callerDid: { equalTo: "bogus" }
            }
          ) {
            nodes {
              datetime
              blockId
              eventIdx
            }
          }
        }
      `,
    });

    expect(res?.errors).toBeFalsy();
    expect(res?.data?.tickerExternalAgentAddeds.nodes).toEqual([]);
  });
});
