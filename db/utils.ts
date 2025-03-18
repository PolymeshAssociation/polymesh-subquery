import * as dotenv from 'dotenv';
import { chdir, env } from 'process';
import { DataSource } from 'typeorm';

chdir(__dirname);

dotenv.config(); // eslint-disable-line @typescript-eslint/no-var-requires

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

export const getPostgresConnection = async (): Promise<DataSource> => {
  const maxAttempts = env.NODE_ENV === 'local' ? 10 : 1;
  const dataSource = new DataSource({
    type: 'postgres',
    host: env.DB_HOST,
    port: Number(env.DB_PORT),
    username: env.DB_USER,
    password: env.DB_PASS,
    database: env.DB_DATABASE,
    name: 'postgres',
  });
  return retry(
    maxAttempts,
    1000,
    async () => await dataSource.initialize(),
    () => {
      console.log('Database connection not ready, retrying in 1s');
    }
  );
};

export const dbIsReady = (postgres: DataSource, retryAttempts = 100): Promise<void> => {
  return retry(
    retryAttempts,
    1000,
    async () => {
      const query = postgres.createQueryBuilder().select('id').from('events', 'e').limit(1);
      await query.getRawOne();
    },
    () => {
      console.log('Database schema not ready, retrying in 1s');
    }
  );
};
