import { gql } from '@apollo/client/core';
import { eveDid } from '../consts';
import { expectQueryToMatchSnapshot } from '../util';

describe('instructions', () => {
  it('should return first 10 instructions', () =>
    expectQueryToMatchSnapshot(gql`
      query {
        instructions(first: 10, orderBy: ID_ASC) {
          totalCount
          nodes {
            createdBlockId
            status
            venueId
            type
            legs(orderBy: LEG_INDEX_ASC) {
              nodes {
                legType
                legIndex
                fromId
                fromPortfolioId
                toId
                toPortfolioId
                nftIds
                assetId
                amount
                addresses
              }
            }
          }
        }
      }
    `));

  it('should return instructions where a particular DID is involved', () =>
    expectQueryToMatchSnapshot(gql`
        query {
          legs(
            filter: {
              fromId: {
                equalTo: "${eveDid}"
              }
            }
            orderBy: ID_ASC
          ) {
            nodes {
              instruction {
                id
                createdBlockId
                status
                legs(orderBy: ID_ASC) {
                  nodes {
                    fromId
                    fromPortfolioId
                    toId
                    toPortfolioId
                    assetId
                    amount
                    addresses
                  }
                }
              }
            }
          }
        }
    `));

  it('should return instructions for a particular Asset', () =>
    expectQueryToMatchSnapshot(gql`
      query {
        legs(filter: { assetId: { equalTo: "11BTICKER1" } }, orderBy: ID_ASC) {
          nodes {
            instruction {
              id
              createdBlockId
              status
              legs(orderBy: ID_ASC) {
                nodes {
                  fromId
                  fromPortfolioId
                  toId
                  toPortfolioId
                  assetId
                  amount
                  addresses
                }
              }
            }
          }
        }
      }
    `));

  it('should return the instructions with address filter', () =>
    expectQueryToMatchSnapshot(gql`
      query {
        legs(
          filter: { addresses: { contains: ["5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"] } }
          orderBy: ID_ASC
        ) {
          nodes {
            instruction {
              id
              createdBlockId
              status
              legs(orderBy: ID_ASC) {
                nodes {
                  fromId
                  fromPortfolioId
                  toId
                  toPortfolioId
                  assetId
                  amount
                  addresses
                }
              }
            }
          }
        }
      }
    `));
});
