import { readFileSync } from 'fs';
import { genesisMigrationQueries } from '../db/genesisMigrations';
import { dbIsReady, getPostgresConnection } from '../db/utils';

const main = async (): Promise<void> => {
  const postgres = await getPostgresConnection();

  await dbIsReady(postgres);

  try {
    await postgres.query(readFileSync('../db/compat.sql', 'utf-8'));
    console.log('Applied initial SQL');

    const migrationQueries = await genesisMigrationQueries();
    await postgres.query(migrationQueries.join('\n'));
    console.log('Applied genesis migration SQL');
  } catch (e) {
    console.error('Error occurred while running genesis migrations', e);
    process.exit(1);
  }
};

main()
  .then(() => process.exit(0))
  .catch(async e => {
    console.error(e);
    process.exit(1);
  });
