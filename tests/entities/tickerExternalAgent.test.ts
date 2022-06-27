import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('tickerExternalAgent', () => {
  it('should return the time block and event index when an agent was added to a ticker', async () => {
    const q = {
      variables: { ticker: '12TICKER' },
      query: gql`
        query q($ticker: String!) {
          tickerExternalAgents(
            filter: {
              assetId: { equalTo: $ticker }
              callerId: {
                equalTo: "0x0854afeca045161ef42ba9be94c973f65efc0e8532933500865a1fd655148f6c"
              }
            }
          ) {
            nodes {
              callerDid: callerId
              datetime
              createdBlockId
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
  it('should return empty when an agent has been removed', async () => {
    const q = {
      variables: { ticker: '12TICKER' },
      query: gql`
        query q($ticker: String!) {
          tickerExternalAgents(
            filter: {
              assetId: { equalTo: $ticker }
              callerId: {
                equalTo: "0xeb686d5391c1123fcd252419bc1e77b525f46bddc8964d34e74be0988c419fea"
              }
            }
          ) {
            nodes {
              datetime
              createdBlockId
              eventIdx
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data?.tickerExternalAgents.nodes).toEqual([]);
  });
  it('should return empty when the agent is not found', async () => {
    const res = await query({
      variables: { ticker: '12TICKER' },
      query: gql`
        query q($ticker: String!) {
          tickerExternalAgents(
            filter: { assetId: { equalTo: $ticker }, callerId: { equalTo: "bogus" } }
          ) {
            nodes {
              datetime
              createdBlockId
              eventIdx
            }
          }
        }
      `,
    });

    expect(res?.errors).toBeFalsy();
    expect(res?.data?.tickerExternalAgents.nodes).toEqual([]);
  });
});
