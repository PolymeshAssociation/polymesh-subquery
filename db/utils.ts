import { Connection, createConnection } from 'typeorm';
import { env, chdir } from 'process';
chdir(__dirname);

require('dotenv').config(); // eslint-disable-line @typescript-eslint/no-var-requires

export const sleep = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms));

export const retry = async <T>(
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

export const getPostgresConnection = async (): Promise<Connection> => {
  return retry(
    env.NODE_ENV === 'local' ? 10 : 1,
    1000,
    async () =>
      await createConnection({
        type: 'postgres',
        host: env.DB_HOST,
        port: Number(env.DB_PORT),
        username: env.DB_USER,
        password: env.DB_PASS,
        database: env.DB_DATABASE,
        name: 'postgres',
      }),
    () => {
      console.log('Database connection not ready, retrying in 1s');
    }
  );
};
