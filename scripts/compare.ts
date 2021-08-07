import {
  Connection,
  createConnection,
  QueryBuilder,
  SelectQueryBuilder,
} from "typeorm";
import { isMaster, fork, on as clusterOn } from "cluster";
import { createWriteStream } from "fs";
import expect from "expect";

const find_in_pairs = <T, K>(
  arr: T[],
  func: (a: T, b: T) => K | undefined
): K | undefined => {
  for (var i = 0; i < arr.length - 1; i++) {
    const res = func(arr[i], arr[i + 1]);
    if (res !== undefined) {
      return res;
    }
  }
  return undefined;
};
const byteLength = (s: string) => new TextEncoder().encode(s).length;
const crawl = (a: any) => {
  if (typeof a === "object") {
    for (const i in a) {
      if (
        typeof i === "string" &&
        i.startsWith("event_arg_") &&
        typeof a[i] === "string" &&
        byteLength(a[i]) === 100
      ) {
        // This is a heuristic that says:
        // If the column is 100 characters then it was probably truncated and
        // therefore we don't care about it.
        a[i] = expect.anything();
      } else if (i === "offchainAccuracy") {
        // as far as I can tell offchainAccuracy is deserialized wrong in the harvester
        a[i] = expect.anything();
      } else if (a[i] === "null") {
        // Coalesce "null" and null
        a[i] = null;
      } else if (typeof a[i] === "string") {
        // Remove null characters because postgresql doesn't support them
        a[i] = a[i].replace(/\0|\\u0000/g, "");
      } else if (typeof a[i] === "number") {
        // reduce number precision to allow slight deviation between subquery and harvester
        a[i] = a[i].toPrecision(13);
      } else {
        [crawl(a[i])];
      }
    }
  }
};

const findMissingBlock = (results: { block_id: number }[]) =>
  find_in_pairs(results, (a, b) =>
    a.block_id !== b.block_id + 1 ? a.block_id : undefined
  );

const BATCH_SIZE = 100;
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
const START_BLOCK = 1187881;
const MAX_BLOCK = START_BLOCK + 10000 * BATCH_SIZE;

const compareTable = async (
  q: TableQuery,
  table_name: string,
  mysql: Connection,
  postgres: Connection
) => {
  const errorStream = createWriteStream(`errors_${table_name}`, {
    flags: "w",
  });
  let i = START_BLOCK;
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
      crawl(h);
      crawl(s);
      try {
        expect(h).toMatchObject(s);
      } catch (e) {
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
      return;
    }
    i = blockEnd;
  }
};

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
    // Only sometimes populated in the harvester .addSelect("extrinsic_hash")
    .addSelect("extrinsic_length")
    // this doesn't match? 32 vs 84.addSelect("extrinsic_version")
    .addSelect("signed")
    // Not populated by the harvester
    //.addSelect("address_length")
    //.addSelect("address")
    //.addSelect("signature")
    //.addSelect("nonce")
    //.addSelect("era")
    .addSelect("call_id")
    .addSelect("module_id")
    .addSelect("params")
    .addSelect("success")
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
    host: "0.0.0.0",
    port: 5432,
    username: "postgres",
    password: "postgres",
    database: "postgres",
    name: "postgres",
  });
  const mysql = await createConnection({
    type: "mysql",
    host: "localhost",
    port: 33061,
    username: "root",
    password: "root",
    database: "itn",
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
