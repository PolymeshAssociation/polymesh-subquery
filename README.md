# Polymesh Subquery

This project has been initially created to replace [the harvester](https://github.com/PolymathNetwork/polkascan-pre-harvester) meaning the output of both should match as much as possible, however since the harvester serializes chain objects in slightly different ways than polkadot-js, this project contains a list of special cases handled both at the initial deserialization level (in [project.yaml](project.yaml).network.types) and at the serialization level in [serializeLikeHarvester.ts](src/mappings/serializeLikeHarvester.ts).

## Running

1. Set the chain endpoint in [project.yaml](project.yaml).network.endpoint.
2. Set the starting block in [project.yaml](project.yaml).dataSources.main.startingBlock (this repo has been designed to work from the start of spec version 2021, aka block 1187881)
3. Install subql cli: `npm i -g @subql/cli`
4. `rerun.sh` (requires docker compose)
5. Once the postgres instance is up run `psql -h 0.0.0.0 -U postgres -d postgres -a -f compat.sql`

## Comparing output with harvester

1. Set the right configuration in `scripts/.env`
2. `npm run compare` 