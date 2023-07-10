import { readdirSync, readFileSync } from 'fs';
import { Connection } from 'typeorm';
import { version as latestVersion } from '../package.json';
import { upsertVersionMetadata } from './sqVersions';
import { getPostgresConnection } from './utils';

const getLastMigrationFromDB = (postgres: Connection) => {
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
) => `INSERT INTO "public"."migrations" ("id", "number", "version", "created_at", "updated_at")
VALUES ('${id || migrationNumber}', ${migrationNumber}, '${latestVersion}', now(), now())
ON CONFLICT(id) DO UPDATE SET "updated_at" = now();`;

export const schemaMigrations = async (connection?: Connection): Promise<void> => {
  const postgres = await (connection ?? getPostgresConnection());

  let lastMigration = 0;
  try {
    const migrationDetails = await getLastMigrationFromDB(postgres);
    lastMigration = migrationDetails?.lastMigration || 0;
  } catch (e) {
    console.log(`Error message: ${e.message}`);
  }

  const queries: string[] = [];

  if (lastMigration === 0) {
    /**
     * This will make sure if anyone running an older version has an unexecuted migration,
     * all of those will also get executed.
     */
    console.log('Collecting all old migrations');

    const oldMigrations = readdirSync('../db/old_migrations');

    for (const oldMigration of oldMigrations) {
      queries.push(readFileSync(`../db/old_migrations/${oldMigration}`, 'utf-8'));
      queries.push(
        migrationInsert(0, `0/${oldMigration.substring(0, oldMigration.indexOf('.sql'))}`)
      );
    }
  }

  const migrations = readdirSync('../db/migrations');

  if (lastMigration >= 0) {
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
      await postgres.query([...queries, upsertVersionMetadata].join('\n'));
      console.log(`Applied all migrations and updated the version to ${latestVersion}`);
    } else {
      console.log('Skipping schema migrations');
    }
  }
};
