import { exec } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { gql } from "@apollo/client/core";
import { getApolloClient } from "./util";
import teardown from "./teardown";
const execAsync = promisify(exec);

const cwd = join(__dirname, "..");
const { query } = getApolloClient();

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
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
const WAIT_UNTIL_BLOCK = 1000;
export = async () => {
  try {
    console.log("");
    console.log("Starting test environment, might take a minute or two...");
    await Promise.all([
      execAsync("polymesh-local start -s 4.0.0 -c -o chain", { cwd }),
      execAsync("docker-compose up --build -d --always-recreate-deps -V", {
        cwd,
      }),
    ]);
    console.log("Test environment started, waiting for subquery to catch up");
    await sleep(20000);
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
      if (!(data.blocks.nodes[0].blockId > WAIT_UNTIL_BLOCK)) {
        console.log(
          `Last processed block: ${data.blocks.nodes[0].blockId}/${WAIT_UNTIL_BLOCK}`
        );
        throw new Error("Subquery not caught up");
      }
    });
    console.log("Ready!");
  } catch (e) {
    await teardown();
    throw e;
  }
};
