import { schemaMigrations } from '../db/schemaMigrations';

const main = async (migrateFrom?: string) => {
  try {
    return await schemaMigrations(undefined, migrateFrom);
  } catch (e) {
    console.log("Couldn't run schema migrations ", e);
  }
};

main(process.argv[2])
  .then(() => process.exit(0))
  .catch(async e => {
    console.error(e);
    process.exit(1);
  });
