#!/bin/bash -xe

set -xe -o pipefail
_term() {
	echo "Caught SIGTERM signal!"
	kill -TERM "$child" 2>/dev/null
}
trap _term SIGTERM

# If NETWORK_CHAIN_ID is not set and we have an http endpoint to use, then curl the chain to fetch it (might need to retry)
if [[ -n $NETWORK_HTTP_ENDPOINT ]] && [[ -z $NETWORK_CHAIN_ID ]]
then
  export NETWORK_CHAIN_ID=$(curl --silent -H "Content-Type: application/json" -d '{"id":"1", "jsonrpc":"2.0", "method": "chain_getBlockHash", "params":[0]}' $NETWORK_HTTP_ENDPOINT |
  grep -o '"result":"[^"]*' |
  grep -o '[^"]*$'
)
  echo "NETWORK_CHAIN_ID was set to ${NETWORK_CHAIN_ID} based on calling: $NETWORK_HTTP_ENDPOINT. Production chains should explictly set NETWORK_CHAIN_ID instead"
fi

npm run build ## This creates the project.yaml file

npm run migrations

# Allow configuring node memory. It should be no more than 75% of available RAM.
# Defaults to 3 GB (expecting at least 4 GB available).
NODE_SPACE=${MAX_OLD_SPACE_SIZE:-3072}

NODE_OPTIONS=--max_old_space_size="$NODE_SPACE" \
	/bin/run --disable-historical=false \
	--db-schema=public "$@" &
child=$!

# `db/compat.sql` adds generated columns and expression indexes to tables the node creates, so it
# has to run after the node has built the schema. It used to run in the background with a
# `kill "$$"` on failure, which raced the node and reported nothing useful when it lost. It waits
# for the schema itself, so it is run here in the foreground and its failure stops the container.
if ! npm run sql; then
	echo "Failed to apply db/compat.sql; stopping the indexer" >&2
	kill -TERM "$child" 2>/dev/null
	wait "$child" || true
	exit 1
fi

wait "$child"
