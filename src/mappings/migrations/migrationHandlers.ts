import { Event } from '../../types';
import { mapPolyxTransaction } from '../entities/mapPolyxTransaction';

let dataMigrationStarted = false;

/**
 * Processes the already processed blocks and their events once on startup.
 * This helps running data migration queries using the SQ entities.
 *
 * Once a new block is received, the method is triggered.
 * For each block, it fetches the events and process accordingly as per data migration requirements
 *
 * @note For adding in schema changes (like new events in chain upgrade, adding a type to existing enum), we still need to use the sql migration queries as those are supposed to be executed before the SQ startup.
 */
export default async (blockId: number, ss58Format?: number): Promise<void> => {
  if (!dataMigrationStarted) {
    dataMigrationStarted = true; // setting this to true prevents running this repeatedly

    for (let blockNumber = 0; blockNumber <= blockId; blockNumber++) {
      const events = await Event.getByBlockId(blockNumber.toString());
      if (events) {
        for (const event of events) {
          await mapPolyxTransaction(event, ss58Format);
        }
      }
    }
  }
};
