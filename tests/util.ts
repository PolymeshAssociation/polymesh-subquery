import { cryptoWaitReady } from '@polkadot/util-crypto';

import { ApolloClient, HttpLink, InMemoryCache, NormalizedCacheObject } from '@apollo/client/core';
import fetch from 'cross-fetch';
import { Keyring } from '@polkadot/api';

export function getApolloClient(): ApolloClient<NormalizedCacheObject> {
  return new ApolloClient({
    link: new HttpLink({ uri: 'http://0.0.0.0:3001/graphql', fetch }),
    cache: new InMemoryCache(),
    defaultOptions: { query: { fetchPolicy: 'no-cache' } },
  });
}

const keyring = new Keyring({ type: 'sr25519' });

export const addressFromUri = async (seed: string): Promise<string> => {
  await cryptoWaitReady();
  const pair = keyring.addFromUri(seed);
  return pair.address;
};

// export const addressIdentity = async (
//   address: string,
//   query: ApolloClient<NormalizedCacheObject>['query']
// ): Promise<string> => {
//   const q = {
//     query: gql`
//       query(address: $string) {
//         account(address: $address)(
//           filter: {
//             address: {
//               equalTo: "$address"
//             }
//           }
//         ) {
//           nodes {
//             nodeId
//             id
//             fromId
//             toId
//             assetId
//             amount
//             address
//           }
//         }
//       }
//     `,
//   };

//   const res = await query(q, { address });

//   return res.data.identityId;
// };
