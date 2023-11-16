import { SubstrateEvent } from '@subql/types';
import { mapBlock } from './entities/mapBlock';
import { createExtrinsic } from './entities/mapExtrinsic';
import mapSubqueryVersion from './entities/mapSubqueryVersion';
import genesisHandler from './migrations/genesisHandler';
import migrationHandlers from './migrations/migrationHandlers';
import { logError } from './util';
import { createEvent } from './entities/mapEvent';

export async function handleEvent(substrateEvent: SubstrateEvent): Promise<void> {
  const header = substrateEvent.block.block.header;
  const ss58Format = header.registry.chainSS58;
  const blockId = header.number.toNumber();

  /**
   * This handles the insertion of new SQ version on every restart
   */
  await mapSubqueryVersion().catch(e => logError(e));

  /**
   * This manages the insertion of all the genesis block data on processing block #1
   */
  if (blockId === 1) {
    await genesisHandler().catch(e => logError(e));
  }

  /**
   * In case some data needs to be migrated for newly added entities/attributes to any entity, this can be used
   */
  await migrationHandlers(blockId, ss58Format).catch(e => logError(e));

  const promises = [];
  const block = await mapBlock(substrateEvent.block);
  promises.push(block.save());

  if (substrateEvent.extrinsic) {
    const extrinsic = createExtrinsic(substrateEvent.extrinsic);
    promises.push(extrinsic.save());
  }

  const event = await createEvent(
    substrateEvent,
    substrateEvent.idx,
    substrateEvent.block,
    substrateEvent.extrinsic
  );
  promises.push(event.save());

  await Promise.all(promises);
}
