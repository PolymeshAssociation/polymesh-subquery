import { Connection } from 'typeorm';
import { version as latestVersion } from '../package.json';
import { getPostgresConnection } from './utils';

export const upsertVersionMetadata = `
  INSERT INTO "public"."subquery_versions" ("id", "version", "created_at", "updated_at")
  VALUES ('${latestVersion}', '${latestVersion}', now(), now())
  ON CONFLICT(id) DO UPDATE SET "updated_at" = now();
`;

export const updateSQVersion = async (connection?: Connection): Promise<void> => {
  const postgres = await (connection ?? getPostgresConnection());

  await postgres.query(upsertVersionMetadata);

  console.log(`Added the new version ${latestVersion} to 'subquery_versions'`);
};
