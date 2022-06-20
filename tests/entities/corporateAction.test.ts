import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('distributions', () => {
  it('should return the withholding taxes for a distribution', async () => {
    const q = {
      variables: { ticker: '13TICKER' },
      query: gql`
        query q($ticker: String!) {
          distributions(filter: { assetId: { equalTo: $ticker }, localId: { equalTo: 0 } }) {
            nodes {
              taxes
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

describe('distributionPayments', () => {
  it('should get payment history for a distribution', async () => {
    const q = {
      variables: { caId: '13TICKER/0' },
      query: gql`
        query q($caId: String!) {
          distributionPayments(filter: { distributionId: { equalTo: $caId } }) {
            totalCount
            nodes {
              amount
              createdBlockId
              datetime
              eventDid: targetId
              eventId
              tax
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
