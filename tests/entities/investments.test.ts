import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('investments', () => {
  it('should return investments for sto', async () => {
    const q = {
      query: gql`
        query {
          investments(filter: { offeringToken: { equalTo: "14TICKER" }, stoId: { equalTo: 0 } }) {
            totalCount
            nodes {
              createdBlockId
              investor: investorId
              stoId
              offeringToken
              raiseToken
              offeringTokenAmount
              raiseTokenAmount
              datetime
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
