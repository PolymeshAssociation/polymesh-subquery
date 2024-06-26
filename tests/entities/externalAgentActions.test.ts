import { gql } from '@apollo/client/core';
import { eveDid } from '../consts';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

const ticker = '12TICKER';

describe('tickerExternalAgentActions', () => {
  it('should return the transactions for ticker', async () => {
    const q = {
      variables: { ticker },
      query: gql`
        query q($ticker: String!) {
          tickerExternalAgentActions(filter: { assetId: { equalTo: $ticker } }, orderBy: ID_ASC) {
            totalCount
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
    expect(subquery?.data).toMatchSnapshot();
  });

  it('should filter by event id', async () => {
    const q = {
      variables: { ticker },
      query: gql`
        query q($ticker: String!) {
          tickerExternalAgentActions(
            filter: { assetId: { equalTo: $ticker }, eventId: { equalTo: FundraiserFrozen } }
          ) {
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
    expect(subquery?.data).toMatchSnapshot();
  });

  it('should filter by pallet name', async () => {
    const q = {
      variables: { ticker },
      query: gql`
        query q($ticker: String!) {
          tickerExternalAgentActions(
            filter: { assetId: { equalTo: $ticker }, palletName: { equalTo: "compliancemanager" } }
          ) {
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
    expect(subquery?.data).toMatchSnapshot();
  });

  it('should filter by caller DID', async () => {
    const q = {
      variables: { ticker },
      query: gql`
        query q($ticker: String!) {
          tickerExternalAgentActions(
            filter: {
              assetId: { equalTo: $ticker }
              callerId: {
                equalTo: "${eveDid}"
              }
            } 
            orderBy: ID_ASC
          ) {
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
    expect(subquery?.data).toMatchSnapshot();
  });
});
