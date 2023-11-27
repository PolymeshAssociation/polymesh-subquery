import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { gql } from '@apollo/client/core';
import { getApolloClient } from './util';
import teardown from './teardown';
import fetch from 'cross-fetch';
const execAsync = promisify(exec);

const cwd = join(__dirname, '..');
const { query } = getApolloClient();

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
const retry = async <T>(
  n: number,
  ms: number,
  f: () => Promise<T>,
  onRetry: () => void = () => {}
): Promise<T> => {
  let err = undefined;
  for (let i = 0; i < n; i++) {
    try {
      return await f();
    } catch (e) {
      err = e;
    }

    onRetry();
    await sleep(ms);
  }
  throw err;
};

/**
 * record of historical snapshots that were tested against. Most recent should go at top
 * The most recent *should* be good enough for CI, but a record should be kept just in case
 */
const snapShotArgs = [
  '-v 5.0.3 -s https://github.com/PolymeshAssociation/polymesh-local/releases/download/assets/v5.0.3-integration-snapshot.tgz',
  '-i polymeshassociation/polymesh:4.1.2-mainnet-debian -s https://github.com/PolymeshAssociation/polymesh-local/releases/download/assets/4.0.0-integration-snapshot.tgz',
];

export default async (): Promise<void> => {
  // eslint-disable-next-line no-useless-catch
  try {
    console.log('\nStarting test environment, might take a minute or two...');
    await Promise.all([
      execAsync(`polymesh-local start -o chain ${snapShotArgs[0]}`, { cwd }),
      execAsync('docker-compose up --build -d --always-recreate-deps -V', {
        cwd,
      }),
    ]);
    console.log('Test environment started, waiting for subquery to catch up');
    await sleep(20000);

    const latestBlock = 400;

    await retry(200, 2000, async () => {
      const { errors, data } = await query({
        query: gql`
          query {
            blocks(first: 1, orderBy: [BLOCK_ID_DESC]) {
              nodes {
                blockId
              }
            }
          }
        `,
      });
      if (errors) {
        throw errors;
      }
      if (data.blocks.nodes[0].blockId < latestBlock) {
        console.log(`Last processed block: ${data.blocks.nodes[0].blockId}/${latestBlock}`);
        throw new Error('Subquery not caught up');
      }
    });
    console.log('Ready!');
  } catch (e) {
    await teardown();
    throw e;
  }
};

export const fetchLatestBlock = async (): Promise<number> => {
  const chainHttp = 'http://localhost:9933';
  const headers = { 'Content-Type': 'application/json' };

  const lastBlockRequest = { id: '1', jsonrpc: '2.0', method: 'system_syncState' };
  const response = await fetch(chainHttp, {
    headers,
    method: 'POST',
    body: JSON.stringify(lastBlockRequest),
  });

  const jsonResponse = await response.json();
  const {
    result: { currentBlock },
  } = jsonResponse as any;

  return currentBlock - 5; // give some buffer for non finalized blocks
};
