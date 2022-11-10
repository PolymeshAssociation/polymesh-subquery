import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('tickerExternalAgentActions', () => {
  it('should return the transactions for ticker', async () => {
    const q = {
      variables: { ticker: '12TICKER' },
      query: gql`
        query q($ticker: String!) {
          tickerExternalAgentActions(filter: { assetId: { equalTo: $ticker } }) {
            totalCount
            nodes {
              palletName
              eventId
              callerId
            }
          }
        }
      `,
    };
    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });

  it('should filter by event id', async () => {
    const q = {
      variables: { ticker: '12TICKER' },
      query: gql`
        query q($ticker: String!) {
          tickerExternalAgentActions(
            filter: { assetId: { equalTo: $ticker }, eventId: { equalTo: FundraiserFrozen } }
          ) {
            nodes {
              palletName
              eventId
              callerId
            }
          }
        }
      `,
    };
    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });

  it('should filter by pallet name', async () => {
    const q = {
      variables: { ticker: '12TICKER' },
      query: gql`
        query q($ticker: String!) {
          tickerExternalAgentActions(
            filter: { assetId: { equalTo: $ticker }, palletName: { equalTo: "compliancemanager" } }
          ) {
            nodes {
              palletName
              eventId
              callerId
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });

  it('should filter by caller DID', async () => {
    const q = {
      variables: { ticker: '12TICKER' },
      query: gql`
        query q($ticker: String!) {
          tickerExternalAgentActions(
            filter: {
              assetId: { equalTo: $ticker }
              callerId: {
                equalTo: "0x0854afeca045161ef42ba9be94c973f65efc0e8532933500865a1fd655148f6c"
              }
            }
          ) {
            nodes {
              palletName
              eventId
              callerId
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
