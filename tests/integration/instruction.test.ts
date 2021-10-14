import { gql } from "@apollo/client/core";
import { getApolloClient } from "../util";
const { query } = getApolloClient();

describe("getInstructions", () => {
  test("test getting instructions", async () => {
    const q = {
      query: gql`
        query {
          instructions(first: 10) {
            totalCount
            nodes {
              blockId
              status
              venueId
              settlementType
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
