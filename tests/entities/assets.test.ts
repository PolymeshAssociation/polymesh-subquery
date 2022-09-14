import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('assets', () => {
  it('should return all Asset details', async () => {
    const q = {
      query: gql`
        query {
          assets(filter: { ticker: { in: ["4TICKER", "15TICKER", "7TICKER", "11BTICKER1"] } }) {
            nodes {
              nodeId
              id
              ticker
              name
              type
              fundingRound
              isDivisible
              isFrozen
              isUniquenessRequired
              identifiers
              ownerDid: ownerId
              totalSupply
              totalTransfers
              isCompliancePaused
              transferManagers {
                nodes {
                  type
                  value
                  exemptedEntities
                }
              }
              compliance {
                nodes {
                  id: complianceId
                  data
                }
              }
              holders {
                nodes {
                  did: identityId
                  amount
                }
              }
              documents {
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
    expect(subquery?.data).toMatchSnapshot();
  });
});
