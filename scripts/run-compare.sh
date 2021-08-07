#!/bin/bash
trap 'trap - SIGTERM && kill $(jobs -p)' SIGINT SIGTERM EXIT
cd "$(dirname "$0")"
TABLE=data_block npx ts-node compare.ts &
TABLE=data_extrinsic npx ts-node compare.ts &
TABLE=data_event npx ts-node compare.ts &
wait
