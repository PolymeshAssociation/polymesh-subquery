[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![Github Actions Workflow](https://github.com/PolymeshAssociation/polymesh-subquery/actions/workflows/main.yml/badge.svg)](https://github.com/PolymeshAssociation/polymesh-subquery/actions)
[![Sonar Status](https://sonarcloud.io/api/project_badges/measure?project=PolymeshAssociation_polymesh-subquery&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=PolymeshAssociation_polymesh-subquery)
[![Issues](https://img.shields.io/github/issues/PolymeshAssociation/polymesh-subquery)](https://github.com/PolymeshAssociation/polymesh-subquery/issues)

# Polymesh Subquery

Polymesh Subquery allows for querying historical events on the Polymesh chain through a GraphQL interface. This project is based on [SubQuery](https://github.com/subquery/subql), and contains the mappings specific to Polymesh.

## Running

1. In the [docker-compose.yml](docker-compose.yml) file, set the appropriate [environment variables](#env-settings) for `subquery-node` container
2. Install subql cli: `npm i -g @subql/cli`
3. `./rerun.sh` (requires docker compose). To persist data between runs, remove the `-v` flag, which causes the docker volume to be removed

## Version

This SubQuery version works with chain versions 6.2.x

### ENV settings

The behavior of the dev image can be controlled by setting ENV variables. The default entrypoint is `docker-entrypoint.sh`, which should be looked at to fully understand these settings. Notable ones include:

- `NETWORK_ENDPOINT` - the wss endpoint of the blockchain to be indexed
- `NETWORK_CHAIN_ID` - The genesis hash of the chain. This value can be retrieved by going to the explorer and looking for the block hash of block 0. e.g. [for mainnet](https://mainnet-app.polymesh.network/#/explorer/query/0)
- `NETWORK_DICTIONARY` - The GraphQL endpoint of SubQuery Dictionary Project that pre-indexes events on chain to dramatically improve indexing of this SubQuery Project (sometimes up to 10x faster). The dictionary has already pre-scanned over the network, and has records of the module and method for every event/extrinsic on each block. If you don't have dictionary setup you can see examples of how to create a dictionary in the [dictionary repository](https://github.com/subquery/subql-dictionary). Polymesh dictionary can be referenced from [here](https://github.com/PolymeshAssociation/subql-dictionary).
- `START_BLOCK` - block from which indexing should start. Generally this should be set to 1, but other values can be useful for debugging.

More advanced options are:

- `MAX_OLD_SPACE_SIZE` — this will be passed onto the node process as `--max-old-space-size` flag. The recommendation is for this to be ~75% of available RAM. Defaults to 1536, a setting appropriate for 2GB.

## Historical state tracking

Polymesh SubQuery now, by default, tracks the historical state of all the entities. This allows to query the state of any entity at any block height.

**NOTE** - This requires the PostgreSQL to have a `btree_gist` extension. You can use the following query to create the extension -

```SQL
CREATE EXTENSION IF NOT EXISTS btree_gist;
```

To disable this feature, you can pass `--disable-historical=true` as one of the command arguments to the `subquery-node` container. Refer to [docker-compose.yml](./docker-compose.yml#L61) for example

Read more about querying historical state [here](https://academy.subquery.network/indexer/run_publish/historical.html#querying-historical-state).

## License

This project uses [SubQuery](https://github.com/subquery/subql), which is [Apache 2.0 licensed](./LICENSE).

The project itself is also [Apache 2.0 licensed](./LICENSE).
