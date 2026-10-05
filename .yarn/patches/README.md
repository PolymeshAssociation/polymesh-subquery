# Dependency patches

Fixes to dependencies, applied by Yarn on install through `resolutions` in `package.json`. An
install fails if a patch no longer applies, so a dependency upgrade that changes the patched code
cannot pass unnoticed. Drop a patch, and its `resolutions` entry, once upstream ships the fix.

The indexer image runs the project's own `@subql/node` from `node_modules`, not the copy in its
base image, so these patches are what runs in production.

## `@subql-node-core-npm-19.0.0-*.patch`: dictionary queries retained in memory

A backport of [subquery/subql#3048](https://github.com/subquery/subql/pull/3048) to node-core
19.0.0. Drop it once a node-core release that includes that PR is in use.

The v1 dictionary client writes each batch's block range into its GraphQL query text and parsed
every query with `gql` for Apollo Client, and both graphql-tag's and Apollo's caches kept every
parsed document. With this project's handler filters each document is about 1.7 MB, so the main
thread grew by about 450 MB per million blocks synced through the dictionary, until a testnet
genesis resync crashed on the kernel's memory-mapping limit. The PR describes the cause in full.

The patch posts dictionary queries as plain GraphQL over HTTP (`DictionaryV1.query()`), so nothing
is parsed or cached. Unlike the PR, it leaves `@subql/node`'s spec-version query on Apollo: that
query's text is fixed, so it caches one document, and patching it would need a second package.
