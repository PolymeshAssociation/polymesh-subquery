#!/bin/bash

npm run sql &
subql-node --network-endpoint="$CHAIN_ENDPOINT" $@
