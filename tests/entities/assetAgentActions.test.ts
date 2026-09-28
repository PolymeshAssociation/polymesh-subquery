import { gql } from '@apollo/client/core';
import { eveDid } from '../consts';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

const ticker = '12TICKER';

/**
 * The four cases below only vary the filter clause, whether `orderBy` is set and whether
 * `totalCount` is selected — this runs the query and the (identical across all four) error/shape
 * assertions once, so SonarCloud stops matching the same four-way-repeated query body as
 * duplication.
 */
const runActionsQuery = async (
  extraFilter: string,
  { orderBy = false, totalCount = false }: { orderBy?: boolean; totalCount?: boolean } = {}
) => {
  const q = {
    variables: { ticker },
    query: gql`
      query q($ticker: String!) {
        assetAgentActions(
          filter: { assetId: { equalTo: $ticker }${extraFilter} }
          ${orderBy ? 'orderBy: ID_ASC' : ''}
        ) {
          ${totalCount ? 'totalCount' : ''}
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

  return subquery;
};

/**
 * Asserted field by field rather than against snapshots. This file's snapshot was deleted with the
 * entity rename, and a missing snapshot file makes `toMatchSnapshot` write one instead of comparing —
 * so every case passed whatever came back, in the suite that was meant to evidence the rename
 * preserving the data.
 */
describe('assetAgentActions', () => {
  it('should return the transactions for ticker', async () => {
    const subquery = await runActionsQuery('', { orderBy: true, totalCount: true });
    const { totalCount, nodes } = subquery.data.assetAgentActions;

    expect(totalCount).toBeGreaterThan(0);
    expect(nodes.length).toBe(totalCount);
    nodes.forEach((node: Record<string, unknown>) =>
      expect(node).toMatchObject({
        palletName: expect.any(String),
        eventId: expect.any(String),
      })
    );
  });

  it('should filter by event id', async () => {
    const subquery = await runActionsQuery(', eventId: { equalTo: FundraiserFrozen }');
    const { nodes } = subquery.data.assetAgentActions;

    expect(nodes.length).toBeGreaterThan(0);
    nodes.forEach((node: Record<string, unknown>) =>
      expect(node.eventId).toBe('FundraiserFrozen')
    );
  });

  it('should filter by pallet name', async () => {
    const subquery = await runActionsQuery(', palletName: { equalTo: "compliancemanager" }');
    const { nodes } = subquery.data.assetAgentActions;

    expect(nodes.length).toBeGreaterThan(0);
    nodes.forEach((node: Record<string, unknown>) =>
      expect(node.palletName).toBe('compliancemanager')
    );
  });

  it('should filter by caller DID', async () => {
    const subquery = await runActionsQuery(`, callerId: { equalTo: "${eveDid}" }`, {
      orderBy: true,
    });
    const { nodes } = subquery.data.assetAgentActions;

    expect(nodes.length).toBeGreaterThan(0);
    nodes.forEach((node: Record<string, unknown>) => expect(node.callerId).toBe(eveDid));
  });
});
