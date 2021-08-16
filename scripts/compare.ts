import { Connection, createConnection, QueryBuilder } from "typeorm";
import { createWriteStream } from "fs";
import { env } from "process";
import expect from "expect";

require("dotenv").config(); // eslint-disable-line @typescript-eslint/no-var-requires

/**
 * This function runs the function `func` on pairs of items from `arr` returning the value
 * returned by `func` whenever it is not undefined
 */
const findInPairs = <T, K>(
  arr: T[],
  func: (a: T, b: T) => K | undefined
): K | undefined => {
  if (arr.length < 2) {
    return undefined;
  }
  for (let i = 0; i < arr.length - 1; i++) {
    const res = func(arr[i], arr[i + 1]);
    if (res !== undefined) {
      return res;
    }
  }
  return undefined;
};

const byteLength = (s: string) => new TextEncoder().encode(s).length;

// This function is designed to modify objects returned by the database recursively
// such that known inevitable differences between the harvester and subquery are not
// detected in the diff.
const compensateAcceptedDifferences = (a: any) => {
  if (typeof a === "object") {
    for (const i in a) {
      if (
        typeof i === "string" &&
        i.startsWith("event_arg_") &&
        typeof a[i] === "string" &&
        byteLength(a[i]) >= 100
      ) {
        // This is a heuristic that says:
        // If the column is 100 characters then it was probably truncated and
        // therefore we don't care about it.
        //
        // It is necessary because the null characters in mysql cause the truncation
        // to be different between the harvester and subquery.
        a[i] = expect.anything();
      } else if (i === "offchainAccuracy") {
        // As far as I can tell offchainAccuracy is deserialized wrong in the harvester.
        a[i] = expect.anything();
      } else if (typeof a[i] === "string") {
        // Remove null characters because postgresql doesn't support them.
        a[i] = a[i].replace(/\0|\\u0000/g, "");
        // Also parse it if it is paseable.
        try {
          a[i] = JSON.parse(a[i]);
        } catch {
          //ignore
        }
      } else if (typeof a[i] === "number") {
        // Reduce number precision to allow slight deviation between subquery and harvester.
        // Specifically for "score" in "staking::submit_election_solution_unsigned".
        a[i] = a[i].toPrecision(13);
      } else {
        compensateAcceptedDifferences(a[i]);
      }
    }
  }
};

/**
 * @returns the index of the block before a block gap
 */
const findMissingBlock = (results: { block_id: number }[]) =>
  findInPairs(results, (a, b) =>
    a.block_id !== b.block_id + 1 ? a.block_id : undefined
  );

enum DB {
  POSTGRES,
  MYSQL,
}
type TableQuery = (
  db: DB
) => (
  qb: QueryBuilder<any>,
  blockStart: number,
  blockEnd: number
) => Promise<any[]>;

const START_BLOCK = parseInt(env.START_BLOCK);
const MAX_BLOCK = parseInt(env.MAX_BLOCK);
const BATCH_SIZE = parseInt(env.BATCH_SIZE);

const compareTable = async (
  q: TableQuery,
  table_name: string,
  mysql: Connection,
  postgres: Connection
) => {
  let hasError = false;

  const errorFileName = `errors_${table_name}`;
  const errorStream = createWriteStream(errorFileName, {
    flags: "w",
  });

  let i = START_BLOCK;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const blockStart = i;
    const blockEnd = Math.min(i + BATCH_SIZE, MAX_BLOCK);

    const harvester_result = await q(DB.MYSQL)(
      mysql.createQueryBuilder(),
      blockStart,
      blockEnd
    );
    const subquery_result = await q(DB.POSTGRES)(
      postgres.createQueryBuilder(),
      blockStart,
      blockEnd
    );

    if (harvester_result.length < subquery_result.length) {
      throw new Error(
        `Missing block in harvester ${table_name}: ${findMissingBlock(
          harvester_result
        )}, harvester result length: ${
          harvester_result.length
        }, subquery result length: ${subquery_result.length}`
      );
    }
    if (subquery_result.length < harvester_result.length) {
      throw new Error(
        `Missing block in subquery ${table_name}: ${findMissingBlock(
          subquery_result
        )}, harvester result length: ${
          harvester_result.length
        }, subquery result length: ${subquery_result.length}`
      );
    }

    for (const [s, h] of zip(subquery_result, harvester_result)) {
      compensateAcceptedDifferences(h);
      compensateAcceptedDifferences(s);
      try {
        expect(h).toMatchObject(s);
      } catch (e) {
        hasError = true;
        if (
          !errorStream.write(
            `\n--------------------------------------------\n${e.toString()}`
          )
        ) {
          await new Promise((res, rej) =>
            errorStream.once("drain", (error) =>
              error ? rej(error) : res(undefined)
            )
          );
        }
      }
    }

    console.log(
      `Processed blocks (${table_name}) [${blockStart}, ${blockEnd}]`
    );

    if (blockEnd >= MAX_BLOCK) {
      if (hasError) {
        throw new Error(
          `Table: ${table_name} contains errors, check the ${errorFileName} file`
        );
      } else {
        return;
      }
    }
    i = blockEnd;
  }
};

/**
 * @returns an array of length min(a.length,b.length) of pairs of the items at the same
 * index in `a` and `b`.
 */
const zip = <T, K>(a: T[], b: K[]): [T, K][] => a.map((k, i) => [k, b[i]]);

const eventQuery: TableQuery = (db) => async (qb, blockStart, blockEnd) =>
  qb
    .select("block_id")
    .addSelect("event_idx")
    .addSelect("spec_version_id")
    .addSelect("module_id")
    .addSelect("event_id")
    .addSelect("attributes")
    .addSelect("event_arg_0")
    .addSelect("event_arg_1")
    .addSelect("event_arg_2")
    .addSelect("event_arg_3")
    .addSelect("claim_type")
    .addSelect(
      db === DB.MYSQL ? "cast(claim_scope as JSON)" : "claim_scope::json",
      "clam_scope"
    )
    .addSelect("claim_issuer")
    .addSelect("claim_expiry")
    .from("data_event", "e")
    .where("block_id >= :blockStart AND block_id < :blockEnd", {
      blockStart,
      blockEnd,
    })
    .orderBy("block_id", "ASC")
    .addOrderBy("event_idx", "ASC")
    .getRawMany();

const blockQuery: TableQuery = () => (qb, blockStart, blockEnd) =>
  qb
    .select("id", "block_id")
    .addSelect("parent_id")
    .addSelect("hash")
    .addSelect("parent_hash")
    .addSelect("state_root")
    .addSelect("extrinsics_root")
    .addSelect("count_extrinsics")
    .addSelect("count_extrinsics_unsigned")
    .addSelect("count_extrinsics_signed")
    .addSelect("count_extrinsics_error")
    .addSelect("count_extrinsics_success")
    .addSelect("count_events")
    .addSelect("datetime")
    .addSelect("spec_version_id")
    .from("data_block", "b")
    .where("id >= :blockStart AND id < :blockEnd", {
      blockStart,
      blockEnd,
    })
    .orderBy("block_id", "ASC")
    .getRawMany();

const extrinsicQuery: TableQuery = () => (qb, blockStart, blockEnd) =>
  qb
    .select("block_id")
    .addSelect("extrinsic_idx")
    .addSelect("signed")
    .addSelect("call_id")
    .addSelect("module_id")
    .addSelect("params")
    // This is wrong in the harvester, it says that the extrinsics in block 1810441 failed,
    // however you can see here they succeeded: https://app.polymesh.live/?#/explorer/query/1810441
    //.addSelect("success")
    .addSelect("spec_version_id")
    .from("data_extrinsic", "e")
    .where("block_id >= :blockStart AND block_id < :blockEnd", {
      blockStart,
      blockEnd,
    })
    .orderBy("block_id", "ASC")
    .addOrderBy("extrinsic_idx", "ASC")
    .getRawMany();

const main = async () => {
  const table = process.env.TABLE;

  const postgres = await createConnection({
    type: "postgres",
    host: env.PG_HOST,
    port: parseInt(env.PG_PORT),
    username: env.PG_USER,
    password: env.PG_PASSWORD,
    database: env.PG_DATABASE,
    name: "postgres",
  });
  const mysql = await createConnection({
    type: "mysql",
    host: env.MYSQL_HOST,
    port: parseInt(env.MYSQL_PORT),
    username: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
    name: "mysql",
  });

  switch (table) {
    case "data_event":
      return await compareTable(eventQuery, "data_event", mysql, postgres);
    case "data_block":
      return await compareTable(blockQuery, "data_block", mysql, postgres);
    case "data_extrinsic":
      return await compareTable(
        extrinsicQuery,
        "data_extrinsic",
        mysql,
        postgres
      );
    default:
      throw new Error(`Unknown table: ${table}`);
  }
};

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.log(e);
    process.exit(1);
  });
