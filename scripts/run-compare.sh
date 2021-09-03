#!/bin/bash

# Kill all child processes on exit.
trap 'kill 0' SIGINT SIGTERM EXIT INT

# Change directory to the script directory.
cd "$(dirname "$0")"
TABLE=data_block npx ts-node compare.ts &
TABLE=data_extrinsic npx ts-node compare.ts &
TABLE=data_event npx ts-node compare.ts &

# Wait for all child processes to finish and set the right exit code.
wait

wc errors_data_block
wc errors_data_event
wc errors_data_extrinsic
