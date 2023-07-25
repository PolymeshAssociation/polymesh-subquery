import { Event, Migration } from '../../types';
import { mapPolyxTransaction } from '../entities/mapPolyxTransaction';

let dataMigrationStarted = false;

/**
 * Adds data for older blocks using the `mapPolyxTransaction` handler
 * This will only be executed when introducing the polyxTransaction entity (i.e. with migration handler 3)
 */
const handlePolyxMigration = async (blockId: number, ss58Format?: number) => {
  for (let blockNumber = 0; blockNumber <= blockId; blockNumber++) {
    logger.info(`Processing block - ${blockNumber} for mapping polyx transactions`);
    const events = await Event.getByBlockId(blockNumber.toString());
    if (events) {
      for (const event of events) {
        await mapPolyxTransaction(event, ss58Format);
      }
    }
  }
};

/**
 * This method processes the already indexed blocks and their events once on startup.
 * This helps running data migration queries using the SQ entities.
 *
 * Once a new block is received, the method is triggered.
 * For each block, it fetches the events and process accordingly as per data migration requirements
 *
 * @note For adding in schema changes (like new events in chain upgrade, adding a type to existing enum), we still need to use the sql migration queries as those are supposed to be executed before the SQ startup.
 */
export default async (blockId: number, ss58Format?: number): Promise<void> => {
  if (dataMigrationStarted) {
    return;
  }
  dataMigrationStarted = true;

  const migrations = await Migration.getByExecuted(false);
  logger.info(`Executing migration handlers for ${migrations.length} new migration(s)`);

  for (const migration of migrations) {
    switch (migration.number) {
      case 3:
        await handlePolyxMigration(blockId, ss58Format);
        break;
      default:
        logger.info(`No mapping handlers are associated for migration - ${migration.id}`);
    }
  }
};
