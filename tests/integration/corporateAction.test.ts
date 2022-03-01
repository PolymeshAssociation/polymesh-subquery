import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('withholdingTaxesOfCas', () => {
  test('should return the witholding taxes', async () => {
    const q = {
      variables: { ticker: '13TICKER' },
      query: gql`
        query q($ticker: String!) {
          withholdingTaxesOfCas(filter: { ticker: { equalTo: $ticker }, localId: { equalTo: 0 } }) {
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

describe('historyofPaymentEventsForCas', () => {
  test('should get payment history', async () => {
    const q = {
      variables: { ticker: '13TICKER' },
      query: gql`
        query q($ticker: String!) {
          historyOfPaymentEventsForCas(
            filter: { ticker: { equalTo: $ticker }, localId: { equalTo: 0 } }
          ) {
            totalCount
            nodes {
              balance
              blockId
              datetime
              eventDid
              eventId
              eventIdx
              localId
              tax
              ticker
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
