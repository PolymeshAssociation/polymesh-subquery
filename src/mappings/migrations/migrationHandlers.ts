import { Event, Migration } from '../../types';
import { MAX_PERMISSIBLE_BLOCKS } from '../consts';
import { mapIdentities } from '../entities/mapIdentities';
import { mapPolyxTransaction } from '../entities/mapPolyxTransaction';

let dataMigrationCompleted = false;

/**
 * Adds data for older blocks using the various mapping handler.
 * This will only be executed until the currentMigrationSequence has been completely migrated.
 */
const handleMigration = async (
  currentMigrationSequence: number,
  mappingString: string,
  migratedBlock: number,
  indexedBlock: number,
  ss58Format?: number
) => {
  let currentBlock = migratedBlock;
  while (currentBlock <= indexedBlock && currentBlock <= migratedBlock + MAX_PERMISSIBLE_BLOCKS) {
    logger.debug(`Processing block - ${currentBlock} for mapping ${mappingString}`);
    const events = await Event.getByBlockId(currentBlock.toString());
    if (events) {
      for (const event of events) {
        switch (currentMigrationSequence) {
          case 3:
            await mapPolyxTransaction(event, ss58Format);
            break;
          case 5:
            await mapIdentities(event, ss58Format);
            break;
        }
      }
    }
    currentBlock++;
  }
  logger.info(`Processed block - ${currentBlock} for mapping ${mappingString}`);
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

  logger.info(`Executing migration handlers for ${migrations.length} new migration(s)`);

  if (migrations.length === 0) {
    dataMigrationCompleted = true;
    return;
  }

  const messages = {
    3: 'polyx transactions',
    5: 'identities',
  };

  for (const migration of migrations) {
    const { processedBlock, number } = migration;
    let lastProcessedBlock = 0;

    if (number === 3 || number === 5) {
      lastProcessedBlock = await handleMigration(
        number,
        messages[number],
        processedBlock,
        blockId,
        ss58Format
      );
    } else {
      logger.info(`No mapping handlers are associated for migration - ${migration.id}`);
      migration.executed = true;
    }

    migration.processedBlock = lastProcessedBlock;

    if (processedBlock >= blockId) {
      migration.executed = true;
    }

    await migration.save();
  }
};
