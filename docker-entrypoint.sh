#!/bin/bash

set -Eeuo pipefail

envsubst <project.template.yaml >project.yaml

(
	npm run sql || kill "$$"
) &
subql-node --network-endpoint="$NETWORK_ENDPOINT" $@
