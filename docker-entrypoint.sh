#!/bin/bash -xe

set -xe -o pipefail
_term() {
	echo "Caught SIGTERM signal!"
	kill -TERM "$child" 2>/dev/null
}
trap _term SIGTERM

if [[ -n "$NO_NATIVE_GRAPHQL_DATA" ]]
then
  export CALL_HANDLER='handleToolingCall'
else
  export CALL_HANDLER='handleCall'
fi

if [[ -n "$NO_NATIVE_GRAPHQL_DATA" ]]
then
  export EVENT_HANDLER='handleToolingEvent'
else
  export EVENT_HANDLER='handleEvent'
fi

envsubst <project.template.yaml> project.yaml

(npm run sql || (sleep 3 && kill "$$")) &

node --max-old-space-size=1536 \
	/usr/local/lib/node_modules/@subql/node/bin/run \
	--network-endpoint="$NETWORK_ENDPOINT" $@
child=$!
wait "$child"
