#!/bin/bash

# single-endpoint test harness for Polymesh SubQuery
# Usage: ./scripts/index-one.sh [staging|testnet|mainnet]

set -e

ENDPOINT_TYPE=$1

case $ENDPOINT_TYPE in
  staging)
    ENDPOINT="wss://dev.polymesh.tech/forked/staging/"
    HTTP_RPC="https://dev.polymesh.tech/forked/staging/"
    ;;
  testnet)
    ENDPOINT="wss://dev.polymesh.tech/forked/testnet/"
    HTTP_RPC="https://dev.polymesh.tech/forked/testnet/"
    ;;
  mainnet)
    ENDPOINT="wss://dev.polymesh.tech/forked/mainnet/"
    HTTP_RPC="https://dev.polymesh.tech/forked/mainnet/"
    ;;
  *)
    echo "Usage: $0 [staging|testnet|mainnet]"
    exit 1
    ;;
esac

# Constants
readonly NUMERIC_REGEX='^[0-9]+$'
readonly SEPARATOR_LINE="===================================================="

echo "--- Starting test for $ENDPOINT_TYPE ---"
echo "Endpoint: $ENDPOINT"

# Fetch actual Chain ID from endpoint
echo "Fetching actual Chain ID..."
ACTUAL_CHAIN_ID=$(curl -k -s -H "Content-Type: application/json" -d '{"id":"1", "jsonrpc":"2.0", "method": "chain_getBlockHash", "params":[0]}' "$HTTP_RPC" | jq -r '.result')

if [[ -z "$ACTUAL_CHAIN_ID" || "$ACTUAL_CHAIN_ID" = "null" ]]; then
  echo "Warning: Could not fetch Chain ID from $HTTP_RPC. Using fallback..." >&2
  case $ENDPOINT_TYPE in
    staging) ACTUAL_CHAIN_ID="0x39343c3c2dceb57f2b7355f235f5dd9b4a9d529e325170f04dbf423b1748d8d2" ;;
    testnet) ACTUAL_CHAIN_ID="0x9ebb2d96716186de0500185ea18ec0b54b20917a47fc4281406640b4f2a6838f" ;;
    mainnet) ACTUAL_CHAIN_ID="0x9fe3b53a723364aa158ae52150e7530a2eb2af730642c5a41d6c5ee0926d0fe6" ;;
    *) echo "Error: Unknown endpoint type $ENDPOINT_TYPE" >&2; exit 1 ;;
  esac
fi

export NETWORK_CHAIN_ID=$ACTUAL_CHAIN_ID
echo "Using Chain ID: $NETWORK_CHAIN_ID"

echo "--- Starting test for $ENDPOINT_TYPE ---"
echo "Endpoint: $ENDPOINT"

# Port Configuration
QUERY_PORT=3100
INDEXER_PORT=3101
DB_PORT=5433

# Check for required tools
for tool in jq curl; do
  if ! command -v $tool > /dev/null 2>&1; then
    echo "Error: $tool is required but not installed." >&2
    exit 1
  fi
done

# Check port availability and auto-increment if occupied
check_port() {
  local port=$1
  # Use lsof if available, otherwise just hope for the best or use netstat
  if command -v lsof > /dev/null 2>&1; then
    while lsof -i :$port > /dev/null 2>&1; do
      port=$((port + 1))
    done
  elif command -v netstat > /dev/null 2>&1; then
    while netstat -an | grep LISTEN | grep -q "\.$port"; do
      port=$((port + 1))
    done
  fi
  echo $port
  return 0
}

QUERY_PORT=$(check_port $QUERY_PORT)
INDEXER_PORT=$(check_port $INDEXER_PORT)
DB_PORT=$(check_port $DB_PORT)

echo "Selected Ports:"
echo "  SubQuery Query: $QUERY_PORT"
echo "  SubQuery Indexer Admin: $INDEXER_PORT"
echo "  Postgres: $DB_PORT"

# Env Vars
export DB_USER=postgres
export DB_PASS=postgres
export DB_DATABASE="subql_$ENDPOINT_TYPE"
export DB_HOST=localhost
export DB_PORT=$DB_PORT
export NETWORK_ENDPOINT=$ENDPOINT
export START_BLOCK=1
export NODE_ENV=local
export TZ=UTC

# Container name for this run
CONTAINER_NAME="subql_pg_$ENDPOINT_TYPE"

cleanup() {
  echo "--- Cleaning up ---"
  if [[ -n "$INDEXER_PID" ]]; then kill $INDEXER_PID 2>/dev/null || true; fi
  if [[ -n "$QUERY_PID" ]]; then kill $QUERY_PID 2>/dev/null || true; fi
  if [[ -n "$SQL_PID" ]]; then kill $SQL_PID 2>/dev/null || true; fi
  if [[ -n "$MIGRATIONS_PID" ]]; then kill $MIGRATIONS_PID 2>/dev/null || true; fi
  if docker ps -a --format '{{.Names}}' | grep -q "^$CONTAINER_NAME$"; then
    echo "Stopping and removing Postgres container..."
    docker stop $CONTAINER_NAME > /dev/null 2>&1 || true
    docker rm $CONTAINER_NAME > /dev/null 2>&1 || true
  fi
  return 0
}

trap cleanup EXIT

# 1. Start Postgres via Docker (since we need a clean DB usually)
if command -v docker > /dev/null 2>&1; then
  echo "Starting Postgres container $CONTAINER_NAME on port $DB_PORT..."
  docker run --name $CONTAINER_NAME \
    -e POSTGRES_PASSWORD=$DB_PASS \
    -p $DB_PORT:5432 \
    -d postgres:15-alpine > /dev/null

  # Wait for Postgres to be ready
  echo "Waiting for Postgres to be ready..."
  MAX_RETRIES=30
  COUNT=0
  until docker exec $CONTAINER_NAME pg_isready -U postgres > /dev/null 2>&1 || [[ $COUNT -eq $MAX_RETRIES ]]; do
    sleep 2
    COUNT=$((COUNT + 1))
  done

  if [[ $COUNT -eq $MAX_RETRIES ]]; then
    echo "Error: Postgres failed to start." >&2
    exit 1
  fi
  
  # Create database and enable btree_gist extension (required for historical data)
  docker exec $CONTAINER_NAME psql -U postgres -c "CREATE DATABASE $DB_DATABASE;" > /dev/null
  docker exec $CONTAINER_NAME psql -U postgres -d $DB_DATABASE -c "CREATE EXTENSION IF NOT EXISTS btree_gist;" > /dev/null
else
  echo "Docker not found. Attempting to use local Postgres on port $DB_PORT..."
  # Check if local postgres is running on that port
  if ! pg_isready -p $DB_PORT > /dev/null 2>&1; then
    echo "Error: Local Postgres not found on port $DB_PORT and Docker is not available." >&2
    exit 1
  fi
  # Try to create DB and extension
  createdb -p $DB_PORT -U $DB_USER $DB_DATABASE || echo "Database might already exist."
  psql -p $DB_PORT -U $DB_USER -d $DB_DATABASE -c "CREATE EXTENSION IF NOT EXISTS btree_gist;" || echo "Failed to enable btree_gist. Ensure you have superuser privileges."
fi

# 1.5 Fetch Chain ID (SubQuery needs it if not provided, or it validates it)
# We can use the logic from docker-entrypoint.sh if HTTP_ENDPOINT is available
# But since we have a websocket endpoint, it's harder with simple curl.
# subql-node will fetch it if not provided.

# 2. Build project
echo "Building project..."
yarn build

# 3. Start Indexer First
echo "Starting SubQuery Indexer..."
# --force-clean ensures we start from scratch and create tables
# Memory optimization: limit heap size but allow default workers for queue balance
NODE_OPTIONS="--max-old-space-size=6144" ./node_modules/.bin/subql-node \
  -f . \
  --db-schema=public \
  --port=$INDEXER_PORT \
  --batch-size=5 \
  --force-clean \
  --log-level=info > indexer.log 2>&1 &
INDEXER_PID=$!

# Wait for Indexer to be alive and create schema
echo "Waiting for Indexer to initialize..."
MAX_WAIT=60
WAITED=0
while [[ $WAITED -lt $MAX_WAIT ]]; do
  if grep -q "Nest application successfully started" indexer.log; then
    # Give it a few more seconds to attempt schema sync
    sleep 5
    if grep -q "ERROR" indexer.log; then
       echo "Indexer encountered an error during startup/sync. Check indexer.log" >&2
       tail -n 10 indexer.log
       exit 1
    fi
    echo "Indexer started successfully."
    break
  fi

  if grep -q "ERROR" indexer.log; then
    echo "Indexer failed to start. Check indexer.log" >&2
    tail -n 10 indexer.log
    exit 1
  fi
  sleep 2
  WAITED=$((WAITED + 2))
done

if [[ $WAITED -ge $MAX_WAIT ]]; then
  echo "Timeout waiting for indexer to start." >&2
  exit 1
fi

# 4. Run SQL and Migrations in background
echo "Starting SQL and Migration tasks..."
(yarn sql >> sql.log 2>&1) &
SQL_PID=$!
(yarn migrations >> migrations.log 2>&1) &
MIGRATIONS_PID=$!

# 5. Start Query Service
if [[ -f "./node_modules/.bin/subql-query" ]]; then
  echo "Starting SubQuery Query Service..."
  ./node_modules/.bin/subql-query \
    --name=public \
    --playground \
    --indexer=http://localhost:$INDEXER_PORT \
    --port=$QUERY_PORT > query.log 2>&1 &
  QUERY_PID=$!
else
  echo "SubQuery Query Service binary not found. Skipping GraphQL service..."
fi

# 6. Monitor Evidence
echo "Monitoring indexing progress until caught up with chain head..."

get_indexer_meta() {
  # Return empty JSON object if curl fails to prevent jq errors
  curl -s --max-time 5 http://localhost:$INDEXER_PORT/meta 2>/dev/null || echo "{}"
  return 0
}

# Evidence of DB writes
get_db_total_rows() {
  local count="0"
  if command -v psql > /dev/null 2>&1; then
    count=$(PGPASSWORD=$DB_PASS psql -h localhost -p $DB_PORT -U $DB_USER -d $DB_DATABASE -t -c "SELECT SUM(n_live_tup) FROM pg_stat_user_tables WHERE schemaname = 'public';" 2>/dev/null | xargs 2>/dev/null || echo "0")
  fi

  if [[ "$count" = "0" || -z "$count" || "$count" = "null" ]] && command -v docker > /dev/null 2>&1; then
    count=$(docker exec $CONTAINER_NAME psql -U postgres -d $DB_DATABASE -t -c "SELECT SUM(n_live_tup) FROM pg_stat_user_tables WHERE schemaname = 'public';" 2>/dev/null | xargs 2>/dev/null || echo "0")
  fi
  # Ensure we always return a valid number
  if [[ -z "$count" || "$count" = "null" || ! "$count" =~ $NUMERIC_REGEX ]]; then
    count="0"
  fi
  echo "$count"
  return 0
}

# Initial wait for services to start
sleep 15

# Fetch Chain ID and Target Height
META=$(get_indexer_meta)
CHAIN_ID=$(echo "$META" | jq -r '.chainId // "null"' 2>/dev/null || echo "null")
TARGET_HEIGHT=$(echo "$META" | jq -r '.targetHeight // 0' 2>/dev/null | grep -E "$NUMERIC_REGEX" || echo "0")
TARGET_HEIGHT=${TARGET_HEIGHT:-0}

RETRIES=0
while [[ "$CHAIN_ID" = "null" || "$TARGET_HEIGHT" -eq 0 ]] && [[ $RETRIES -lt 10 ]]; do
  sleep 5
  META=$(get_indexer_meta)
  CHAIN_ID=$(echo "$META" | jq -r '.chainId // "null"' 2>/dev/null || echo "null")
  TARGET_HEIGHT=$(echo "$META" | jq -r '.targetHeight // 0' 2>/dev/null | grep -E "$NUMERIC_REGEX" || echo "0")
  TARGET_HEIGHT=${TARGET_HEIGHT:-0}
  RETRIES=$((RETRIES + 1))
done

echo "Connected to Chain: $ENDPOINT_TYPE"
echo "Chain ID: $CHAIN_ID"
echo "Target Height: $TARGET_HEIGHT"

if [[ "$TARGET_HEIGHT" -eq 0 ]]; then
  echo "Error: Could not determine target height. Is the chain accessible?" >&2
  exit 1
fi

H_START=$(echo "$META" | jq -r '.lastProcessedHeight // 0' 2>/dev/null | grep -E "$NUMERIC_REGEX" || echo "0")
H_START=${H_START:-0}
R_START=$(get_db_total_rows)
START_TIME_EPOCH=$(date +%s)

echo "Starting monitoring at height $H_START (Total DB Rows: $R_START)"
echo "Waiting for indexer to reach $TARGET_HEIGHT..."

LAST_ERROR=""
while true; do
  META=$(get_indexer_meta)
  # lastProcessedHeight is what's committed to DB
  # Use safe numeric extraction: default to 0 if not a valid number
  CURRENT_HEIGHT=$(echo "$META" | jq -r '.lastProcessedHeight // 0' | grep -E "$NUMERIC_REGEX" || echo "0")
  CURRENT_HEIGHT=${CURRENT_HEIGHT:-0}
  # some versions use indexerHeight for the fetching progress
  INDEXER_HEIGHT=$(echo "$META" | jq -r '.indexerHeight // 0' | grep -E "$NUMERIC_REGEX" || echo "0")
  INDEXER_HEIGHT=${INDEXER_HEIGHT:-0}
  TARGET_HEIGHT=$(echo "$META" | jq -r '.targetHeight // 0' | grep -E "$NUMERIC_REGEX" || echo "0")
  TARGET_HEIGHT=${TARGET_HEIGHT:-0}
  
  # Check for errors FIRST (use || true to prevent set -e from exiting)
  ERROR_MSG=$(grep -i "error" indexer.log 2>/dev/null | grep -v "low priority" | grep -v "@polkadot" | grep -v "relation \"events\" does not exist" | tail -n 1 || true)

  if [[ -n "$ERROR_MSG" && "$ERROR_MSG" != "$LAST_ERROR" ]]; then
    echo -e "\n[Indexer Error]: $ERROR_MSG" >&2
    LAST_ERROR="$ERROR_MSG"
  fi

  DISPLAY_HEIGHT=$CURRENT_HEIGHT
  # Safe numeric comparison (both are guaranteed to be numbers now)
  if [[ "$INDEXER_HEIGHT" -gt "$CURRENT_HEIGHT" ]]; then
    DISPLAY_HEIGHT=$INDEXER_HEIGHT
  fi

  # If metadata is lagging, try to peek at the log for the latest height
  if [[ "$DISPLAY_HEIGHT" -eq 0 ]]; then
    LOG_HEIGHT=$(grep "INDEXING:" indexer.log 2>/dev/null | tail -n 1 | grep -o "Current height: [0-9,]*" | grep -o "[0-9,]*" | tr -d ',' || echo "0")
    LOG_HEIGHT=${LOG_HEIGHT:-0}
    # Ensure LOG_HEIGHT is a valid number before comparison
    if [[ "$LOG_HEIGHT" =~ $NUMERIC_REGEX && "$LOG_HEIGHT" -gt 0 ]]; then
      DISPLAY_HEIGHT=$LOG_HEIGHT
    fi
  fi

  if [[ "$TARGET_HEIGHT" -gt 0 ]]; then
    PERCENT=$(awk "BEGIN {printf \"%.2f\", ($DISPLAY_HEIGHT / $TARGET_HEIGHT) * 100}" 2>/dev/null || echo "0.00")
    DB_ROWS=$(get_db_total_rows)
    printf "\rProgress: %d / %d (%s%%) | Committed: %d | DB Rows: %d" "$DISPLAY_HEIGHT" "$TARGET_HEIGHT" "$PERCENT" "$CURRENT_HEIGHT" "$DB_ROWS"
  else
    DB_ROWS=$(get_db_total_rows)
    printf "\rWaiting for indexer status... DB Rows: %d" "$DB_ROWS"
  fi

  if [[ "$CURRENT_HEIGHT" -ge "$TARGET_HEIGHT" && "$TARGET_HEIGHT" -gt 0 ]]; then
    echo -e "\nReached target height $TARGET_HEIGHT!"
    break
  fi
  
  sleep 5
done

END_TIME_EPOCH=$(date +%s)
DURATION=$((END_TIME_EPOCH - START_TIME_EPOCH))
FINAL_ROW_COUNT=$(get_db_total_rows)

# Final Report
echo ""
echo "$SEPARATOR_LINE"
echo "Final Report for $ENDPOINT_TYPE"
echo "$SEPARATOR_LINE"
echo "Endpoint:       $ENDPOINT"
echo "Start Time:     $(date -r $START_TIME_EPOCH)"
echo "End Time:       $(date -r $END_TIME_EPOCH)"
echo "Duration:       $((DURATION / 60))m $((DURATION % 60))s"
echo "Final Height:   $CURRENT_HEIGHT"
echo "Target Height:  $TARGET_HEIGHT"
echo "Total DB Rows:  $FINAL_ROW_COUNT"

PASS=true
REASON=""

if [[ "$CURRENT_HEIGHT" -lt "$TARGET_HEIGHT" ]]; then
  PASS=false
  REASON="Did not reach target height. "
fi

if [[ "$FINAL_ROW_COUNT" -le "$R_START" ]]; then
  PASS=false
  REASON="${REASON}DB row count did not increase. "
fi

if [[ "$PASS" = true ]]; then
  echo "RESULT:         PASS"
else
  echo "RESULT:         FAIL"
  echo "Reason:         $REASON"
  echo "Tail of indexer.log:"
  tail -n 20 indexer.log 2>/dev/null || true
fi
echo "$SEPARATOR_LINE"

# Check for specific failure modes in logs (use || true to prevent exit on no match)
if grep -q "Deprecation" indexer.log 2>/dev/null; then
  echo "Note: Found deprecation warnings in logs."
fi

if grep -q "FATAL" indexer.log 2>/dev/null; then
  PASS=false
  REASON="${REASON}Fatal error found in indexer.log. "
fi

if grep -q "Error occurred while running genesis migrations" sql.log 2>/dev/null; then
  echo "Warning: run-sql.ts failed. Check sql.log"
fi

if grep -q "Skipping migrations" migrations.log 2>/dev/null; then
  echo "Warning: Migrations were skipped. Check migrations.log"
fi

if [[ "$PASS" = true ]]; then
  echo "RESULT:     PASS"
else
  echo "RESULT:     FAIL"
  echo "Reason:     $REASON"
  echo "Tail of indexer.log:"
  tail -n 20 indexer.log
fi
echo "$SEPARATOR_LINE"
