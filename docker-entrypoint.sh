#!/bin/bash

(
	npm run sql || kill "$$"
) &
subql-node --network-endpoint="$NETWORK_ENDPOINT" $@
