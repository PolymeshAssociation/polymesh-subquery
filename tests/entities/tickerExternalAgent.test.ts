import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

const ticker = '12TICKER';
describe('tickerExternalAgent', () => {
  it('should return the time block and event index when an agent was added to a ticker', async () => {
    const q = {
      variables: { ticker },
      query: gql`
        query q($ticker: String!) {
          tickerExternalAgents(
            filter: {
              assetId: { equalTo: $ticker }
              callerId: {
                equalTo: "0xbd8b5c568e457823d3d3f18d2d1cc1ed79a086124760e9df41a4c66e96de9b42"
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
      variables: { ticker },
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
      variables: { ticker },
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
