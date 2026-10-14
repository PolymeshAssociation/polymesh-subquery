import { readFileSync } from 'fs';
import { applySql } from '../db/applySql';
import { trimIndexes } from '../db/trimIndexes';
import { dbIsReady, getPostgresDataSource } from '../db/utils';

const main = async (): Promise<void> => {
  const postgres = await getPostgresDataSource();

  await dbIsReady(postgres);

  try {
    await applySql(sql => postgres.query(sql), readFileSync('../db/compat.sql', 'utf-8'));
    console.log('Applied initial SQL');
  } catch (e) {
    console.error('Error occurred while running genesis migrations', e);
    process.exit(1);
  }

  // Never fatal: an index left behind costs speed, and the next start finishes the job
  try {
    const { trimmed, skipped } = await trimIndexes({
      query: (sql, params) => postgres.query(sql, params),
      transaction: work =>
        postgres.transaction(manager => work((sql, params) => manager.query(sql, params))),
    });
    console.log(`Trimmed ${trimmed} unused GiST indexes, left ${skipped} for the next start`);
  } catch (e) {
    console.error('Could not trim the unused GiST indexes', e);
  }
};

main()
  .then(() => process.exit(0))
  .catch(async e => {
    console.error(e);
    process.exit(1);
  });
