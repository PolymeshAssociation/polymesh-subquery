import { readdirSync, readFileSync } from 'fs';
import { Connection } from 'typeorm';
import { version as latestVersion } from '../package.json';
import { getPostgresConnection } from './utils';

const getSQVersion = (value: string): string =>
  value
    .split('.')
    .map(number => `00${number}`.slice(-3))
    .join('');

const getVersionFromDB = (postgres: Connection) => {
  return postgres
    .createQueryBuilder()
    .select('id', 'sqVersion')
    .from('subquery_versions', 'sv')
    .orderBy('id', 'DESC')
    .limit(1)
    .getRawOne();
};

const upsertVersionMetadata = `INSERT INTO "public"."subquery_versions" ("id", "version", "created_at", "updated_at")
VALUES ('${getSQVersion(latestVersion)}', '${latestVersion}', now(), now())
ON CONFLICT(id) DO UPDATE SET "updated_at" = now();`;

export const schemaMigrations = async (connection?: Connection): Promise<void> => {
  const postgres = await (connection ?? getPostgresConnection());

  let previousVersion;
  try {
    ({ sqVersion: previousVersion } = await getVersionFromDB(postgres));
  } catch (e) {
    console.log(
      `there was a problem fetching the current DB version. If you are migrating from a SQ version older than "5.5.0" a complete resync is recommended. Error message: ${e.message}`
    );
    previousVersion = getSQVersion('5.3.7');
  }

  const migrations = readdirSync('../db/migrations');

  if (previousVersion) {
    console.log(`Migrating from ${previousVersion} to ${getSQVersion(latestVersion)}`);
    const migrationsToRun = migrations
      .map(file => file.substring(0, file.indexOf('.sql')))
      .filter(file => getSQVersion(file) > previousVersion);

    const migrationQueries = migrationsToRun.map(migration => {
      console.log(`Collecting migration - ${migration}`);
      return readFileSync(`../db/migrations/${migration}.sql`, 'utf-8');
    });

    await postgres.query([...migrationQueries, upsertVersionMetadata].join('\n'));

    console.log(`Applied all migrations and updated the version to ${latestVersion}`);
  } else {
    console.log('Skipping schema migrations');
  }
};

export const updateVersion = async (connection?: Connection): Promise<void> => {
  const postgres = await (connection ?? getPostgresConnection());

  await postgres.query(upsertVersionMetadata);

  console.log(`Added the new version ${latestVersion} to 'subquery_versions'`);
};
