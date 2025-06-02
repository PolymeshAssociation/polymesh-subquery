#!/bin/bash
set -e

DEV_ENV_DIR="/tmp/polymesh-dev-env"
INTEGRATION_DIR="$DEV_ENV_DIR/tests"
LOG_FILE="/tmp/polymesh-subquery-test-$(date +%Y%m%d-%H%M%S).log"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
SQ_DIR="$SCRIPT_DIR/.."
COMPOSE_ENV="$INTEGRATION_DIR/../envs/latest"

# register a cleanup function to keep the env clean
function cleanup() {
    echo "[SQ-TEST] cleaning up test environment"

    cd "$SQ_DIR"
    yarn stop:docker

    cd "$INTEGRATION_DIR"
    yarn test:stop

    cd "$SQ_DIR"
    rm -rf $DEV_ENV_DIR
}
trap cleanup EXIT

echo "[SQ-TEST] cloning the dev-env repo..."
git clone https://github.com/PolymeshAssociation/polymesh-dev-env.git "$DEV_ENV_DIR"

# Install integration test packages
cd "$INTEGRATION_DIR"
yarn

# Start just the chain
echo "[SQ-TEST] Starting polymesh node..."
docker compose --env-file "$COMPOSE_ENV" up --detach polymesh-node

# Install SQ packages
cd "$SQ_DIR"
yarn

echo "[SQ-TEST] starting SQ service..."
yarn start:docker > "$LOG_FILE" 2>&1 &

# Wait for the GraphQL service to be ready by making a simple query
# Note: there is an implicit build so a generous amount of time is needed
# to account for less powerful runners
# (expected ~160 second run on GitHub default runner at time of writing)
curl --retry-all-errors --retry-delay 10 --retry 25 \
  "http://localhost:3001/graphql" \
  -H "Content-Type: application/json" \
  -d '{ "query": "{ blocks(first: 1) { nodes { id } } }" }'
echo "[SQ-TEST] SQ service is ready!"

# Connect GraphQL to the den-env network
docker network connect polymesh_polymesh polymesh-subquery-graphql-engine-1

# Now start up other services to depend on the version under test
cd "$INTEGRATION_DIR"
echo "[SQ-TEST] starting up other services..."

REST_MIDDLEWARE_URL='http://polymesh-subquery-graphql-engine-1:3000' docker compose --env-file "$COMPOSE_ENV" up --detach \
  polymesh-rest-api-vault-sm \
  polymesh-rest-api-vault-sm-init \
  environment-ready \
  vault \
  vault-init

echo "[SQ-TEST] waiting for init service to complete..."
docker compose --env-file "$COMPOSE_ENV" wait environment-ready > /dev/null || true

# Ensure the dev-env SubQuery is stopped to ensure its not used by mistake since `docker compose` starts dependent services
docker compose --env-file "$COMPOSE_ENV" stop subquery-graphql subquery-node

GRAPHQL_URL='http://localhost:3001' yarn test:run
