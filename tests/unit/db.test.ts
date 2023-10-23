import { readdirSync } from 'fs';
import { getMigrationVersion } from '../../db/schemaMigrations';

test('migration files', () => {
  const migrations = readdirSync('../db/migrations');

  const invalidFile = migrations.find(file => !getMigrationVersion(file));
  if (invalidFile && invalidFile !== 'README.md') {
    throw new Error(
      `Migration file - ${invalidFile} has incorrect pattern. Migration file should always follow the pattern '{version}_{description}.sql'. For example 'V1_add_new_entity.sql'`
    );
  }
});
