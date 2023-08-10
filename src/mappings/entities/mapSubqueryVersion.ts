import { SubqueryVersion } from '../../types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const version = require('../../../package.json').version;

let subqueryVersionUpdated = false;

/**
 * Adds current version to SubqueryVersion entity
 */
export default async (): Promise<void> => {
  if (subqueryVersionUpdated) {
    return;
  }

  logger.debug(`Current SQ package version - ${version}`);

  const currentInstance = await SubqueryVersion.get(version);

  if (!currentInstance) {
    await SubqueryVersion.create({
      id: version,
      version,
    }).save();
    logger.info(`Added new version '${version}' to 'subquery_versions'`);
  }

  subqueryVersionUpdated = true;
};
