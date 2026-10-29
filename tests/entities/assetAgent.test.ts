import { gql } from '@apollo/client/core';
import { bobDid, eveDid } from '../consts';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

const ticker = '12TICKER';

describe('assetAgent', () => {
  it('should return the block and event index of the agent addition', async () => {
    const q = {
      variables: { ticker },
      query: gql`
        query q($ticker: String!) {
          assetAgents(
            filter: {
              assetId: { equalTo: $ticker }
              identityId: {
                equalTo: "${eveDid}"
              }
            }
          ) {
            nodes {
              identityDid: identityId
              createdEvent {
                blockId
                eventIdx
              }
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data?.assetAgents.nodes).toEqual([
      {
        __typename: 'AssetAgent',
        identityDid: eveDid,
        createdEvent: expect.objectContaining({
          blockId: expect.any(String),
          eventIdx: expect.any(Number),
        }),
      },
    ]);
  });
  it('should return empty when an agent has been removed', async () => {
    const q = {
      variables: { ticker },
      query: gql`
        query q($ticker: String!) {
          assetAgents(
            filter: {
              assetId: { equalTo: $ticker }
              identityId: {
                equalTo: "${bobDid}"
              }
            }, orderBy: ID_ASC
          ) {
            nodes {
              identityId
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();
    expect(subquery?.data?.assetAgents.nodes).toEqual([]);
  });
  it('should return empty when the agent is not found', async () => {
    const res = await query({
      variables: { ticker },
      query: gql`
        query q($ticker: String!) {
          assetAgents(
            filter: { assetId: { equalTo: $ticker }, identityId: { equalTo: "bogus" } }
            orderBy: ID_ASC
          ) {
            nodes {
              identityId
            }
          }
        }
      `,
    });

    expect(res?.errors).toBeFalsy();
    expect(res?.data?.assetAgents.nodes).toEqual([]);
  });
});
