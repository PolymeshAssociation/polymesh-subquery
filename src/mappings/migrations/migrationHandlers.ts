import { Event, Migration } from '../../types';
import { MAX_PERMISSIBLE_BLOCKS } from '../consts';
import { mapPolyxTransaction } from '../entities/mapPolyxTransaction';

let dataMigrationCompleted = false;

/**
 * Adds data for older blocks using the `mapPolyxTransaction` handler.
 * This will only be executed migration version 3 is not yet changed to executed state.
 */
const handlePolyxMigration = async (
  migratedBlock: number,
  indexedBlock: number,
  ss58Format?: number
) => {
  let currentBlock = migratedBlock;
  while (currentBlock <= indexedBlock && currentBlock <= migratedBlock + MAX_PERMISSIBLE_BLOCKS) {
    logger.debug(`Processing block - ${currentBlock} for mapping polyx transactions`);
    const events = await Event.getByBlockId(currentBlock.toString());
    if (events) {
      for (const event of events) {
        await mapPolyxTransaction(event, ss58Format);
      }
    }
    currentBlock++;
  }
  logger.info(`Processed block - ${currentBlock} for mapping polyx transactions`);
  return currentBlock;
};

/**
 * This method processes the already indexed blocks and their events once, on startup.
 * This helps running data migration queries using the SQ entities.
 *
 * Once a new block is received, the method is triggered to process older blocks (max upto `MAX_PERMISSIBLE_BLOCKS`).
 * For each block, it fetches the events and process accordingly as per data migration requirements
 *
 * @note For adding in schema changes (like new events in chain upgrade, adding a type to existing enum),
 * we still need to use the sql migration queries as those are supposed to be executed before the SQ startup.
 * Also, processing say millions of blocks in a single transaction commit may take upto hours to process,
 * thus a MAX_PERMISSIBLE_BLOCKS limit is set which makes sure that the block processor doesn't timeout.
 */
export default async (blockId: number, ss58Format?: number): Promise<void> => {
  if (dataMigrationCompleted) {
    return;
  }

  const migrations = await Migration.getByExecuted(false);

  if (migrations.length === 0) {
    dataMigrationCompleted = true;
    return;
  }

  logger.info(`Executing migration handlers for ${migrations.length} new migration(s)`);

  for (const migration of migrations) {
    const { processedBlock, number } = migration;
    let lastProcessedBlock = 0;

    if (number === 3) {
      lastProcessedBlock = await handlePolyxMigration(processedBlock, blockId, ss58Format);
    } else {
      logger.info(`No mapping handlers are associated for migration - ${migration.id}`);
      migration.executed = true;
    }

    migration.processedBlock = lastProcessedBlock;

    if (processedBlock >= blockId) {
      migration.executed = true;
      dataMigrationCompleted = true;
    }

    await migration.save();
  }
};
