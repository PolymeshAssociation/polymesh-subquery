import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('getFundings', () => {
  test('test getting fundings with ticker filter only 1', async () => {
    const q = {
      query: gql`
        query {
          fundings(filter: { ticker: { equalTo: "8TICKER" } }, first: 10) {
            totalCount
            nodes {
              blockId
              ticker
              fundingName
              value
              totalIssuedInFundingRound
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });

  test('test getting fundings with ticker and fundingName filters 1', async () => {
    const q = {
      query: gql`
        query {
          fundings(
            filter: { fundingName: { equalTo: "first" }, ticker: { equalTo: "8TICKER" } }
            first: 10
          ) {
            totalCount
            nodes {
              blockId
              ticker
              fundingName
              value
              totalIssuedInFundingRound
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });

  test('test getting fundings with ticker and fundingName filters 2', async () => {
    const q = {
      query: gql`
        query {
          fundings(
            filter: { fundingName: { equalTo: "" }, ticker: { equalTo: "8TICKER" } }
            first: 10
          ) {
            totalCount
            nodes {
              blockId
              ticker
              fundingName
              value
              totalIssuedInFundingRound
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
