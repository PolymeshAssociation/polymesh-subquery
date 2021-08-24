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

// blocks in the data_block table known to have been generated wrong in the harvester.
const badDataBlocks = new Set([
  // These were reporting 0 events and 0 successful extrinsics when there were clearly events  in them.
  // https://app.polymesh.live/?rpc=wss%3A%2F%2Fitn-rpc.polymesh.live#/explorer/query/1900291
  // all of them contain only the TimestampSet and ExtrinsicSuccess events.
  1810441,
  1810936, 1811370, 1811478, 1811556, 1811690, 1812012, 1812141, 1812300,
  1812467, 1813102, 1813113, 1813686, 1814591, 1815254, 1815973, 1816475,
  1816484, 1816516, 1817204, 1818092, 1818676, 1819338, 1820002, 1820553,
  1820790, 1821000, 1821054, 1821121, 1821614, 1821816, 1821822, 1821952,
  1821992, 1822666, 1822726, 1823472, 1823861, 1824141, 1824166, 1824244,
  1824290, 1824341, 1824424, 1824446, 1824656, 1824760, 1824770, 1824808,
  1824830, 1824864, 1824895, 1824966, 1825049, 1825212, 1825256, 1825414,
  1825636, 1825677, 1825694, 1825768, 1825909, 1826091, 1826356, 1826361,
  1826415, 1826502, 1826581, 1826723, 1826825, 1827274, 1827344, 1827429,
  1827464, 1827517, 1827574, 1827615, 1827800, 1828632, 1828642, 1828698,
  1828998, 1829248, 1829711, 1829820, 1829939, 1830107, 1830192, 1830277,
  1830822, 1830842, 1830901, 1830920, 1830938, 1830999, 1831030, 1831163,
  1831164, 1831179, 1831223, 1831250, 1831319, 1831328, 1831369, 1831409,
  1831424, 1831647, 1831712, 1831867, 1831906, 1831932, 1831954, 1831963,
  1832020, 1832055, 1832069, 1832115, 1832139, 1832149, 1832161, 1832184,
  1832306, 1832333, 1832561, 1832688, 1832772, 1832793, 1832856, 1832869,
  1832906, 1832915, 1832941, 1832987, 1833116, 1833120, 1833241, 1833317,
  1833483, 1833499, 1833508, 1833517, 1833597, 1833618, 1833792, 1833884,
  1834055, 1834132, 1834201, 1834213, 1834227, 1834256, 1834290, 1834489,
  1834517, 1834527, 1834561, 1834571, 1834671, 1834755, 1834844, 1835043,
  1835073, 1835222, 1835291, 1835361, 1835495, 1835500, 1835602, 1835658,
  1835669, 1835670, 1835681, 1835731, 1835755, 1835804, 1835813, 1835832,
  1835888, 1835901, 1835927, 1835937, 1835975, 1837519, 1837539, 1837594,
  1837607, 1837646, 1838095, 1838205, 1838439, 1839338, 1842029, 1842036,
  1842072, 1842159, 1842281, 1842294, 1842499, 1842584, 1842652, 1842666,
  1842709, 1842740, 1842768, 1842783, 1842784, 1842808, 1842814, 1842938,
  1842989, 1842999, 1843009, 1843049, 1843069, 1843076, 1843144, 1843150,
  1843176, 1843177, 1843199, 1843201, 1843219, 1843247, 1843248, 1843344,
  1843369, 1843393, 1843442, 1843448, 1843499, 1843536, 1843580, 1843585,
  1843587, 1843592, 1843603, 1843608, 1843615, 1843616, 1843621, 1843627,
  1843632, 1843633, 1843635, 1843640, 1843641, 1843644, 1843645, 1843646,
  1843648, 1843651, 1843653, 1843654, 1843658, 1843660, 1843664, 1843665,
  1843666, 1843676, 1843677, 1843693, 1843694, 1843696, 1843701, 1843708,
  1843711, 1843720, 1843721, 1843725, 1843728, 1843732, 1843734, 1843742,
  1843743, 1843746, 1843753, 1843760, 1843762, 1843764, 1843768, 1843769,
  1843777, 1843779, 1843781, 1843791, 1843794, 1843795, 1843799, 1843800,
  1843802, 1843803, 1843806, 1843809, 1843811, 1843812, 1843816, 1843817,
  1843821, 1843822, 1843824, 1843825, 1843826, 1843829, 1843840, 1843842,
  1843847, 1843856, 1843871, 1843873, 1843877, 1843882, 1843892, 1843893,
  1843899, 1843905, 1843909, 1843913, 1843918, 1843919, 1843922, 1843923,
  1843926, 1843932, 1843934, 1843935, 1843945, 1843950, 1843953, 1843954,
  1843956, 1843960, 1843982, 1843993, 1843996, 1843999, 1844006, 1844015,
  1844021, 1844023, 1844024, 1844026, 1844027, 1844052, 1844057, 1844061,
  1844067, 1844075, 1844078, 1844083, 1844087, 1844091, 1844093, 1844094,
  1844095, 1844096, 1844100, 1844102, 1844103, 1844106, 1844109, 1844112,
  1844115, 1844117, 1844120, 1844129, 1844138, 1844141, 1844142, 1844144,
  1844146, 1844149, 1844155, 1844158, 1844161, 1844162, 1844176, 1844184,
  1844187, 1844188, 1844194, 1844199, 1844203, 1844208, 1844213, 1844220,
  1844221, 1844233, 1844239, 1844240, 1844241, 1844247, 1844258, 1844266,
  1844267, 1844276, 1844282, 1844284, 1844287, 1844294, 1844296, 1844324,
  1844331, 1844341, 1844353, 1844364, 1844366, 1844380, 1844389, 1844391,
  1844396, 1844399, 1844400, 1844403, 1844405, 1844413, 1844416, 1844417,
  1844419, 1844421, 1844426, 1844432, 1844441, 1844453, 1844457, 1844494,
  1844504, 1844510, 1844535, 1844580, 1844684, 1844692, 1844708, 1844768,
  1844769, 1844774, 1844786, 1844798, 1844848, 1844853, 1844924, 1844953,
  1844974, 1845096, 1845162, 1845217, 1845236, 1845297, 1845298, 1845328,
  1845369, 1845416, 1845517, 1845535, 1845569, 1845578, 1845678, 1845679,
  1845722, 1845731, 1845742, 1845790, 1845812, 1845814, 1845816, 1845832,
  1845838, 1845890, 1845933, 1845934, 1845952, 1846013, 1846024, 1846095,
  1846135, 1846209, 1846268, 1846383, 1846407, 1846421, 1846434, 1846440,
  1846442, 1846485, 1846538, 1846568, 1846615, 1846626, 1846654, 1846723,
  1846725, 1846736, 1846785, 1846792, 1846798, 1846828, 1846911, 1846916,
  1846920, 1846954, 1847267, 1851770, 1853306, 1856560, 1857874, 1858843,
  1862076, 1866430, 1867999, 1870625, 1871689, 1872721, 1875733, 1876039,
  1877112, 1877994, 1878136, 1880942, 1887033, 1891663, 1891667, 1891681,
  1891703, 1891779, 1891991, 1892061, 1892111, 1892151, 1892152, 1892181,
  1892563, 1893416, 1894739, 1895907, 1898781, 1900291,
]);

const byteLength = (s: string) => new TextEncoder().encode(s).length;

// This function is designed to modify objects returned by the database recursively
// such that known inevitable differences between the harvester and subquery are not
// detected in the diff.
const compensateAcceptedDifferences = (a: any, nested = false) => {
  if (typeof a === "object") {
    for (const i in a) {
      if (
        (!nested && (i === "attributes" || i === "params")) ||
        i === "call_args"
      ) {
        // Subquery doesn't have access to the same type info as the harvester.
        // Thankfully we don't use the type anywhere.
        for (const j in a[i]) {
          delete a[i][j]["type"];
          // We don't produce valueRaw in subquery.
          delete a[i][j]["valueRaw"];
        }
        compensateAcceptedDifferences(a[i], true);
      }
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
        compensateAcceptedDifferences(a[i], true);
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
    ).then((results) => results.filter((r) => !badDataBlocks.has(r.block_id)));

    const subquery_result = await q(DB.POSTGRES)(
      postgres.createQueryBuilder(),
      blockStart,
      blockEnd
    ).then((results) => results.filter((r) => !badDataBlocks.has(r.block_id)));

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
      if (table_name === "data_block" && badDataBlocks.has(s.block_id)) {
        continue;
      }
      compensateAcceptedDifferences(h);
      compensateAcceptedDifferences(s);
      try {
        expect(h).toEqual(s);
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
    .addSelect("success")
    .addSelect("address")
    .addSelect("signedby_address")
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
