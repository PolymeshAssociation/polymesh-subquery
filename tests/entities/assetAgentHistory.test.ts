import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('assetAgentHistory', () => {
  it('should return history of each external agent in ticker', async () => {
    const q = {
      variables: { ticker: '12TICKER' },
      query: gql`
        query q($ticker: String!) {
          assetAgentHistories(filter: { assetId: { equalTo: $ticker } }, orderBy: ID_ASC) {
            nodes {
              ticker: assetId
              did: identityId
              type
              permissions
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

    // asserted field by field rather than against a snapshot: this file's snapshot was deleted with
    // the entity rename, and a missing snapshot makes `toMatchSnapshot` write one instead of
    // comparing — so the assertion passed whatever came back
    const nodes = subquery?.data?.assetAgentHistories.nodes;

    expect(nodes.length).toBeGreaterThan(0);
    nodes.forEach((node: Record<string, unknown>) => {
      expect(node).toMatchObject({
        ticker: '12TICKER',
        did: expect.any(String),
        type: expect.any(String),
        createdEvent: expect.objectContaining({
          blockId: expect.any(String),
          eventIdx: expect.any(Number),
        }),
      });
    });
  });
});
