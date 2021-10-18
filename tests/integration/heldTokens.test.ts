import { gql } from "@apollo/client/core";
import { getApolloClient } from "../util";
const { query } = getApolloClient();

describe("heldTokens", () => {
  test("test getting tokens held by DID", async () => {
    const q = {
      query: gql`
        query {
          heldTokens(
            filter: {
              did: {
                equalTo: "0x0500000000000000000000000000000000000000000000000000000000000000"
              }
            }
          ) {
            totalCount
            nodes {
              token
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
