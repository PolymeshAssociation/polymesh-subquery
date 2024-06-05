import { SubstrateEvent } from '@subql/types';
import { mapBlock } from './entities/mapBlock';
import mapChainUpgrade from './entities/mapChainUpgrade';
import { handleToolingEvent } from './entities/mapEvent';
import { createExtrinsic } from './entities/mapExtrinsic';
import mapSubqueryVersion from './entities/mapSubqueryVersion';
import genesisHandler from './migrations/genesisHandler';
import { logError } from './util';
import { mapExternalAgentAction } from './entities';

let lastBlockHash = '';
let lastEventIdx = -1;
let startupHandled = false;

export async function handleGenesis(): Promise<void> {
  await genesisHandler().catch(e => logError(e));
}

export async function handleMigration(substrateEvent: SubstrateEvent): Promise<void> {
  /**
   * In case of major chain upgrade, we need to process some entities
   */
  await mapChainUpgrade(substrateEvent).catch(e => logError(e));
}

export async function handleStartup(): Promise<void> {
  /**
   * This handles the insertion of new SQ version on every restart
   */
  await mapSubqueryVersion().catch(e => logError(e));
}

export async function handleEvent(substrateEvent: SubstrateEvent): Promise<void> {
  if (!startupHandled) {
    await handleStartup();
    startupHandled = true;
  }

  const promises = [];

  const blockHash = substrateEvent.block.hash.toHex();
  if (lastBlockHash !== blockHash) {
    lastBlockHash = blockHash;
    lastEventIdx = -1;

    const block = mapBlock(substrateEvent.block);
    promises.push(block.save());
  }

  if (substrateEvent?.extrinsic?.idx > lastEventIdx) {
    lastEventIdx = substrateEvent?.extrinsic?.idx;
    const extrinsic = createExtrinsic(substrateEvent.extrinsic);
    promises.push(extrinsic.save());
  }

  const event = handleToolingEvent(substrateEvent);
  promises.push(event.save());

  promises.push(mapExternalAgentAction(substrateEvent));

  await Promise.all(promises);
}
