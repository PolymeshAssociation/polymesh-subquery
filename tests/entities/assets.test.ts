import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('assets', () => {
  it('should return all Asset details', async () => {
    const q = {
      query: gql`
        query {
          assets(
            filter: { ticker: { in: ["4TICKER", "15TICKER", "7TICKER", "8TICKER", "11BTICKER1"] } }
            orderBy: ID_ASC
          ) {
            nodes {
              id
              ticker
              name
              type
              fundingRound
              isDivisible
              isFrozen
              identifiers
              ownerDid: ownerId
              totalSupply
              totalTransfers
              isCompliancePaused
              compliance(orderBy: ID_ASC) {
                nodes {
                  id: complianceId
                  data
                }
              }
              holders(orderBy: ID_ASC) {
                nodes {
                  did: identityId
                  amount
                }
              }
              documents(orderBy: ID_ASC) {
                nodes {
                  id: documentId
                  name
                  link
                  contentHash
                  type
                  filedAt
                }
              }
            }
          }
        }
      `,
    };

    const subquery = await query(q);

    expect(subquery?.errors).toBeFalsy();

    // asserted on the queried set rather than against a snapshot: this file's snapshot was deleted
    // with the entity rename, and a missing snapshot makes `toMatchSnapshot` write one instead of
    // comparing, so the case passed whatever came back
    const { nodes } = subquery.data.assets;

    expect(nodes.map(({ ticker }: { ticker: string }) => ticker).sort()).toEqual(
      ['11BTICKER1', '15TICKER', '4TICKER', '7TICKER', '8TICKER'].sort()
    );
    nodes.forEach((node: Record<string, unknown>) =>
      expect(node).toMatchObject({
        id: expect.any(String),
        ticker: expect.any(String),
        isDivisible: expect.any(Boolean),
        isFrozen: expect.any(Boolean),
        isCompliancePaused: expect.any(Boolean),
        ownerDid: expect.any(String),
        totalSupply: expect.any(String),
        totalTransfers: expect.any(String),
      })
    );
  });
});
