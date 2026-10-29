import {
  ApolloClient,
  DocumentNode,
  HttpLink,
  InMemoryCache,
  NormalizedCacheObject,
} from '@apollo/client/core';
import fetch from 'cross-fetch';

export function getApolloClient(): ApolloClient<NormalizedCacheObject> {
  return new ApolloClient({
    link: new HttpLink({ uri: 'http://0.0.0.0:3001/graphql', fetch }),
    cache: new InMemoryCache(),
    defaultOptions: { query: { fetchPolicy: 'no-cache' } },
  });
}

const { query } = getApolloClient();

/** Runs `document` against the indexer and matches its data to the test's snapshot. */
export async function expectQueryToMatchSnapshot(document: DocumentNode): Promise<void> {
  const subquery = await query({ query: document });

  expect(subquery?.errors).toBeFalsy();
  expect(subquery?.data).toMatchSnapshot();
}
