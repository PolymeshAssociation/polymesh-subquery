import { schemaMigrations } from '../db/schemaMigrations';
import { dbIsReady, getPostgresConnection } from '../db/utils';

const main = async () => {
  const postgres = await getPostgresConnection();

  try {
    await dbIsReady(postgres);
    return await schemaMigrations(postgres);
  } catch (e) {
    console.log("Couldn't run schema migrations ", e);
    process.exit(1);
  }
};

main()
  .then(() => process.exit(0))
  .catch(async e => {
    console.error(e);
    process.exit(1);
  });
