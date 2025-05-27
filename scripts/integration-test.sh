#!/bin/bash

DEV_ENV_DIR="/tmp/polymesh-dev-env"
INTEGRATION_DIR="$DEV_ENV_DIR/tests"
LOG_FILE="/tmp/polymesh-subquery-$(date +%Y%m%d-%H%M%S).log"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
SQ_DIR="$SCRIPT_DIR/.."

echo "cloning the repository"
git clone https://github.com/PolymeshAssociation/polymesh-dev-env.git "$DEV_ENV_DIR"

cd "$INTEGRATION_DIR"
# Install integration test packages
yarn

COMPOSE_ENV="../envs/latest"

# register a cleanup function to keep the env clean
function cleanup() {
    echo "cleaning up test environment"

    cd "$SQ_DIR"
    yarn stop:docker

    cd "$INTEGRATION_DIR"
    yarn test:stop

    cd "$SQ_DIR"
    rm -rf $DEV_ENV_DIR
}
trap cleanup EXIT

docker compose --env-file "$COMPOSE_ENV" up --detach polymesh-node

cd "$SQ_DIR"

# Install SQ packages
yarn
echo "starting SQ service"
yarn start:docker > "$LOG_FILE" 2>&1 &

echo "waiting for SQ service to be ready..."
# Wait for the GraphQL service to be ready by making a simple query
curl --silent --output /dev/null --retry-all-errors --retry-delay 3 --retry 10 \
  "http://localhost:3001/graphql" \
  -H "Content-Type: application/json"\
  -d '{"query": "{ __schema { types { name } } }"}'
echo "SQ service is ready!"

cd "$INTEGRATION_DIR"
echo "starting up other services"

REST_MIDDLEWARE_URL='http://host.docker.internal:3001' docker compose --env-file "$COMPOSE_ENV" up --detach \
  polymesh-rest-api-vault-sm \
  polymesh-rest-api-vault-sm-init \
  environment-ready \
  vault \
  vault-init

echo "waiting for init service to complete..."
docker compose --env-file "$COMPOSE_ENV" wait environment-ready > /dev/null

# Due to docker deps the dev SQ starts up. Stopping it ensures our local version is tested
docker compose --env-file "$COMPOSE_ENV" stop subquery-graphql subquery-node

GRAPHQL_URL='http://localhost:3001' yarn test:run