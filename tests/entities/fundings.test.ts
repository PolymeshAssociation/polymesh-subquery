import { gql } from '@apollo/client/core';
import { expectQueryToMatchSnapshot } from '../util';

describe('fundings', () => {
  it('should return fundings with ticker filter only 1', () =>
    expectQueryToMatchSnapshot(gql`
      query {
        fundings(filter: { assetId: { equalTo: "8TICKER" } }, first: 10, orderBy: ID_ASC) {
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
    `));

  it('should return fundings with ticker and fundingRound filters 1', () =>
    expectQueryToMatchSnapshot(gql`
      query {
        fundings(
          filter: { fundingRound: { equalTo: "first" }, assetId: { equalTo: "8TICKER" } }
          first: 10
          orderBy: ID_ASC
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
    `));

  it('should return fundings with ticker and fundingRound filters 2', () =>
    expectQueryToMatchSnapshot(gql`
      query {
        fundings(
          filter: { fundingRound: { equalTo: "" }, assetId: { equalTo: "8TICKER" } }
          first: 10
          orderBy: ID_ASC
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
    `));
});
