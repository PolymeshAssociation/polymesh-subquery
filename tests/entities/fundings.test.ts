import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('fundings', () => {
  it('should return fundings with ticker filter only 1', async () => {
    const q = {
      query: gql`
        query {
          fundings(filter: { assetId: { equalTo: "8TICKER" } }, first: 10) {
            totalCount
            nodes {
              createdBlockId
              ticker: assetId
              fundingRound
              amount
              totalFundingAmount
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });

  it('should return fundings with ticker and fundingRound filters 1', async () => {
    const q = {
      query: gql`
        query {
          fundings(
            filter: { fundingRound: { equalTo: "first" }, assetId: { equalTo: "8TICKER" } }
            first: 10
          ) {
            totalCount
            nodes {
              createdBlockId
              ticker: assetId
              fundingRound
              amount
              totalFundingAmount
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });

  it('should return fundings with ticker and fundingRound filters 2', async () => {
    const q = {
      query: gql`
        query {
          fundings(
            filter: { fundingRound: { equalTo: "" }, assetId: { equalTo: "8TICKER" } }
            first: 10
          ) {
            totalCount
            nodes {
              createdBlockId
              ticker: assetId
              fundingRound
              amount
              totalFundingAmount
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
