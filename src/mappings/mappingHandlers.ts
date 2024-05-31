import { SubstrateEvent } from '@subql/types';
import { mapBlock } from './entities/mapBlock';
import mapChainUpgrade from './entities/mapChainUpgrade';
import { createEvent } from './entities/mapEvent';
import { createExtrinsic } from './entities/mapExtrinsic';
import mapSubqueryVersion from './entities/mapSubqueryVersion';
import { logError } from './util';

let lastBlockHash = '';
let lastEventIdx = -1;
export async function handleEvent(substrateEvent: SubstrateEvent): Promise<void> {
  /**
   * This handles the insertion of new SQ version on every restart
   */
  await mapSubqueryVersion().catch(e => logError(e));

  /**
   * In case of major chain upgrade, we need to process some entities
   */
  await mapChainUpgrade(substrateEvent).catch(e => logError(e));

  const promises = [];
  const blockHash = substrateEvent.block.hash.toHex();
  if (blockHash !== lastBlockHash) {
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

  const event = await createEvent(
    substrateEvent,
    substrateEvent.idx,
    substrateEvent.block,
    substrateEvent.extrinsic
  );
  promises.push(event.save());

  await Promise.all(promises);
}
