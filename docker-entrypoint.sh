#!/bin/bash -xe

set -xe -o pipefail
_term() {
	echo "Caught SIGTERM signal!"
	kill -TERM "$child" 2>/dev/null
}
trap _term SIGTERM

envsubst <project.template.yaml >project.yaml

(npm run sql || (sleep 3 && kill "$$")) &

node --max-old-space-size=1536 \
	/usr/local/bin/subql-node \
	--network-endpoint="$NETWORK_ENDPOINT" $@
child=$!
wait "$child"
