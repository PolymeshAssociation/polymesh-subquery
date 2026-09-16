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

describe('assetAgentActions', () => {
  it('should return the transactions for ticker', async () => {
    const subquery = await runActionsQuery('', { orderBy: true, totalCount: true });

    expect(subquery?.data).toMatchSnapshot();
  });

  it('should filter by event id', async () => {
    const subquery = await runActionsQuery(', eventId: { equalTo: FundraiserFrozen }');

    expect(subquery?.data).toMatchSnapshot();
  });

  it('should filter by pallet name', async () => {
    const subquery = await runActionsQuery(', palletName: { equalTo: "compliancemanager" }');

    expect(subquery?.data).toMatchSnapshot();
  });

  it('should filter by caller DID', async () => {
    const subquery = await runActionsQuery(`, callerId: { equalTo: "${eveDid}" }`, {
      orderBy: true,
    });

    expect(subquery?.data).toMatchSnapshot();
  });
});
