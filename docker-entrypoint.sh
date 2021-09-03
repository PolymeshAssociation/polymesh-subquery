#!/bin/bash

npm run sql &
subql-node --network-endpoint="$NETWORK_ENDPOINT" $@
