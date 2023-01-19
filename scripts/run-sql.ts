import { readFileSync } from 'fs';
import { migrationQueries } from '../db/migration';
import { updateVersion } from '../db/schemaMigrations';
import { getPostgresConnection, retry } from '../db/utils';

const main = async (): Promise<void> => {
  const postgres = await getPostgresConnection();

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

  try {
    await postgres.query(readFileSync('../db/compat.sql', 'utf-8'));
    console.log('Applied initial SQL');

    await postgres.query(migrationQueries().join('\n'));
    console.log('Applied initial migration SQL');

    await updateVersion(postgres);
  } catch (e) {
    console.error('Error occurred while running initial migrations', e);
    process.exit(1);
  }
};

main()
  .then(() => process.exit(0))
  .catch(async e => {
    console.error(e);
    process.exit(1);
  });
