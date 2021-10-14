import { gql } from "@apollo/client/core";
import { getApolloClient } from "../util";
const { query } = getApolloClient();

describe("stakingEvents", () => {
  test("should return staking events", async () => {
    const q = {
      query: gql`
        query {
          stakingEvents {
            nodes {
              stakingEventId
              date
              identityId
              stashAccount
              amount
              nominatedValidators
            }
            totalCount
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });
  test("should return nomination events", async () => {
    const q = {
      query: gql`
        query {
          stakingEvents(filter: { stakingEventId: { equalTo: "Nominated" } }) {
            nodes {
              stakingEventId
              date
              identityId
              stashAccount
              amount
              nominatedValidators
            }
            totalCount
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });
  test("should filter by account", async () => {
    const q = {
      query: gql`
        query {
          stakingEvents(
            filter: {
              stashAccount: {
                equalTo: "0x301ae89b2d71df51a78bfa5700385a7612bd34cf0a482407eccdafc17ef75121"
              }
            }
          ) {
            nodes {
              stakingEventId
              date
              identityId
              stashAccount
              amount
              nominatedValidators
            }
            totalCount
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });
});
