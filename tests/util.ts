import { ApolloClient, HttpLink, InMemoryCache } from "@apollo/client/core";
import fetch from "cross-fetch";

export function getApolloClient() {
  return new ApolloClient({
    link: new HttpLink({ uri: "http://0.0.0.0:3001/graphql", fetch }),
    cache: new InMemoryCache(),
    defaultOptions: { query: { fetchPolicy: "no-cache" } },
  });
}
