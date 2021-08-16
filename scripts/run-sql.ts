import { createConnection } from "typeorm";
import { env, chdir } from "process";
import { readFileSync } from "fs";
chdir(__dirname);

require("dotenv").config(); // eslint-disable-line @typescript-eslint/no-var-requires

const sleep = (n: number) => new Promise((res) => setTimeout(res, n));

const main = async () => {
  const postgres = await createConnection({
    type: "postgres",
    host: env.PG_HOST,
    port: parseInt(env.PG_PORT),
    username: env.PG_USER,
    password: env.PG_PASSWORD,
    database: env.PG_DATABASE,
    name: "postgres",
  });
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const query = postgres
      .createQueryBuilder()
      .select("id")
      .from("events", "e")
      .limit(1);
    try {
      await query.getRawOne();
      break;
    } catch (e) {
      console.log("Database not ready, retrying in 1s");
    }

    await sleep(1000);
  }

  await postgres.query(readFileSync("../compat.sql", "utf-8"));
  console.log("Applied initial SQL");
};

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.log(e);
    process.exit(1);
  });
