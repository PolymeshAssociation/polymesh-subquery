import { gql } from '@apollo/client/core';
import { getApolloClient } from '../util';
const { query } = getApolloClient();

describe('bridgeEvents', () => {
  it('should return bridge events', async () => {
    const q = {
      query: gql`
        query {
          bridgeEvents(
            filter: {
              txHash: {
                equalTo: "0x7737bbd561123ae867b5a33f790be73599fed4d7c6cbcb77dbbf2c82252a0b77"
              }
            }
          ) {
            nodes {
              createdBlockId
              recipient
              amount
              identityId
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
