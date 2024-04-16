import { gql } from '@apollo/client/core';
import { bobDid, eveDid } from '../consts';
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
                equalTo: "${eveDid}"
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
                equalTo: "${bobDid}"
              }
            }, orderBy: ID_ASC
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
            orderBy: ID_ASC
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
