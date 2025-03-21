import { randomUUID } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { DataSource } from 'typeorm';
import { version as latestVersion } from '../package.json';
import { getPostgresDataSource } from './utils';

const getLastMigrationFromDB = (postgres: DataSource) => {
  return postgres
    .createQueryBuilder()
    .select('number', 'lastMigration')
    .from('migrations', 'm')
    .orderBy('number', 'DESC')
    .limit(1)
    .getRawOne();
};

export const getMigrationVersion = (fileName: string): number | null => {
  const regex = /^(\d+)_(?:.*).sql/; // Regex pattern to match the version number
  const match = fileName.match(regex);

  if (match && match.length >= 2) {
    return parseInt(match[1]);
  }

  return null; // Return null if the version number is not found or invalid
};

const migrationInsert = (
  migrationNumber: number,
  id?: string
) => `INSERT INTO "public"."migrations" ("id", "_id", "number", "version", "executed", "processed_block", "_block_range")
VALUES ('${
  id || migrationNumber
}', '${randomUUID()}', ${migrationNumber},'${latestVersion}', 1, 0, '[1,)');`;

export const schemaMigrations = async (dataSource?: DataSource): Promise<void> => {
  const postgres = await (dataSource ?? getPostgresDataSource());

  let lastMigration = 0;
  try {
    const migrationDetails = await getLastMigrationFromDB(postgres);
    lastMigration = migrationDetails?.lastMigration || 0;
  } catch (e) {
    console.log(`Error message: ${e.message}`);
  }

  const queries: string[] = [];

  const migrations = readdirSync('../db/migrations');

  console.log(`Last executed migration sequence - ${lastMigration}`);

  for (const file of migrations) {
    const fileVersion = getMigrationVersion(file);

    if (fileVersion && fileVersion > lastMigration) {
      console.log(`Collecting migration file - ${file}`);

      queries.push(readFileSync(`../db/migrations/${file}`, 'utf-8'));
      queries.push(migrationInsert(fileVersion));
    }
  }

  if (queries.length > 0) {
    const assembleQueries = (q: string) =>
      q.replace(/public_enum_([a-z0-9]+)/g, '"$1"').replace(/'"([a-z0-9]+)"'/g, "'$1'");

    await postgres.query([...queries.map(assembleQueries)].join('\n'));
    console.log(`Applied all migrations and updated the version to ${latestVersion}`);
  } else {
    console.log('Skipping schema migrations');
  }
};
