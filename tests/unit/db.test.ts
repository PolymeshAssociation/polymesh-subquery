import { readdirSync } from 'fs';
import { getMigrationVersion } from '../../db/schemaMigrations';

test('migration files', () => {
  const migrations = readdirSync('../db/migrations');

  const invalidFile = migrations.find(file => !getMigrationVersion(file));
  if (invalidFile) {
    throw new Error(
      `Migration file - ${invalidFile} has incorrect pattern. Migration file should always follow the pattern 'V{version}_{description}.sql'. For example 'V1_add_new_entity.sql'`
    );
  }
});
