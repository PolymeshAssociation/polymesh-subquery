import { schemaMigrations } from '../db/schemaMigrations';

const main = async () => {
  try {
    return await schemaMigrations();
  } catch (e) {
    console.log("Couldn't run schema migrations ", e);
  }
};

main()
  .then(() => process.exit(0))
  .catch(async e => {
    console.error(e);
    process.exit(1);
  });
