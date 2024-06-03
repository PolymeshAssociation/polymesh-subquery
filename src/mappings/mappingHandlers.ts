import { SubstrateEvent } from '@subql/types';
import { mapBlock } from './entities/mapBlock';
import mapChainUpgrade from './entities/mapChainUpgrade';
import { createEvent } from './entities/mapEvent';
import { createExtrinsic } from './entities/mapExtrinsic';
import mapSubqueryVersion from './entities/mapSubqueryVersion';
import genesisHandler from './migrations/genesisHandler';
import { logError } from './util';
import migrationHandlers from './migrations/migrationHandlers';

let lastBlockId = -1;
let lastEventIdx = -1;

export async function handleGenesis(): Promise<void> {
  await genesisHandler().catch(e => logError(e));
}

export async function handleEvent(substrateEvent: SubstrateEvent): Promise<void> {
  const header = substrateEvent.block.block.header;
  const blockId = header.number.toNumber();

  const promises = [];
  if (lastBlockId !== blockId) {
    lastBlockId = blockId;
    lastEventIdx = -1;

    /**
     * This handles the insertion of new SQ version on every restart
     */
    await mapSubqueryVersion().catch(e => logError(e));

    /**
     * In case some data needs to be migrated for newly added entities/attributes to any entity, this can be used
     */
    const ss58Format = header.registry.chainSS58;
    await migrationHandlers(blockId, ss58Format).catch(e => logError(e));

    /**
     * In case of major chain upgrade, we need to process some entities
     */
    await mapChainUpgrade(substrateEvent).catch(e => logError(e));

    const block = mapBlock(substrateEvent.block);
    promises.push(block.save());
  }

  if (substrateEvent?.extrinsic?.idx > lastEventIdx) {
    lastEventIdx = substrateEvent?.extrinsic?.idx;
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
