import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('tickerExternalAgentActions', () => {
  test('should return the transactions for ticker', async () => {
    const q = {
      variables: { ticker: '12TICKER' },
      query: gql`
        query q($ticker: String!) {
          tickerExternalAgentActions(filter: { ticker: { equalTo: $ticker } }) {
            totalCount
            nodes {
              palletName
              eventId
              callerDid
            }
          }
        }
      `,
    };
    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });

  test('should filter by event id', async () => {
    const q = {
      variables: { ticker: '12TICKER' },
      query: gql`
        query q($ticker: String!) {
          tickerExternalAgentActions(
            filter: { ticker: { equalTo: $ticker }, eventId: { equalTo: "FundraiserFrozen" } }
          ) {
            nodes {
              palletName
              eventId
              callerDid
            }
          }
        }
      `,
    };
    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });

  test('should filter by pallet name', async () => {
    const q = {
      variables: { ticker: '12TICKER' },
      query: gql`
        query q($ticker: String!) {
          tickerExternalAgentActions(
            filter: { ticker: { equalTo: $ticker }, palletName: { equalTo: "compliancemanager" } }
          ) {
            nodes {
              palletName
              eventId
              callerDid
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data).toMatchSnapshot();
  });

  test('should filter by caller DID', async () => {
    const q = {
      variables: { ticker: '12TICKER' },
      query: gql`
        query q($ticker: String!) {
          tickerExternalAgentActions(
            filter: {
              ticker: { equalTo: $ticker }
              callerDid: {
                equalTo: "0x0854afeca045161ef42ba9be94c973f65efc0e8532933500865a1fd655148f6c"
              }
            }
          ) {
            nodes {
              palletName
              eventId
              callerDid
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