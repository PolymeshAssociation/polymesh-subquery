import { createConnection } from 'typeorm';
import { env, chdir } from 'process';
import { readFileSync } from 'fs';
chdir(__dirname);

require('dotenv').config(); // eslint-disable-line @typescript-eslint/no-var-requires

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

const main = async () => {
  const postgres = await retry(
    env.NODE_ENV === 'local' ? 10 : 1,
    1000,
    async () =>
      await createConnection({
        type: 'postgres',
        host: env.DB_HOST,
        port: parseInt(env.DB_PORT),
        username: env.DB_USER,
        password: env.DB_PASS,
        database: env.DB_DATABASE,
        name: 'postgres',
      }),
    () => {
      console.log('Database connection not ready, retrying in 1s');
    }
  );

  await retry(
    100,
    1000,
    async () => {
      const query = postgres.createQueryBuilder().select('id').from('events', 'e').limit(1);
      await query.getRawOne();
    },
    () => {
      console.log('Database schema not ready, retrying in 1s');
    }
  );

  await postgres.query(readFileSync('../db/compat.sql', 'utf-8'));
  console.log('Applied initial SQL');

  if (env.NODE_ENV === 'local') {
    await postgres.query(readFileSync('../db/localMigration.sql', 'utf-8'));
    console.log('Applied migration SQL');
  }
};

main()
  .then(() => process.exit(0))
  .catch(async e => {
    console.error(e);
    process.exit(1);
  });
