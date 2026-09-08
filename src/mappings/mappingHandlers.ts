import { SubstrateEvent } from '@subql/types';
import { logError } from '../utils';
import { getBlockContext } from './blockContext';
import { mapExternalAgentAction } from './entities';
import { mapBlock } from './entities/block/mapBlock';
import mapChainUpgrade from './entities/block/mapChainUpgrade';
import { handleExtrinsic } from './entities/block/mapExtrinsic';
import mapSubqueryVersion from './entities/block/mapSubqueryVersion';
import { handleToolingEvent } from './entities/events/mapEvent';
import genesisHandler from './migrations/genesisHandler';

export async function handleGenesis(): Promise<void> {
  // this is need to populate subquery version on startup
  await handleStartup();
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
   * This handles the insertion of new SQ version on every restart.
   *
   * `mapSubqueryVersion` is itself once-per-process and checks the table before writing, so this
   * is called unconditionally rather than gated by a second flag out here
   */
  await mapSubqueryVersion().catch(e => logError(e));
}

export async function handleEvent(substrateEvent: SubstrateEvent): Promise<void> {
  await handleStartup();

  const context = getBlockContext(substrateEvent.block);
  const promises = [];

  if (!context.blockWritten) {
    context.blockWritten = true;

    /**
     * The `Block` row is written from here rather than from a block handler, so a block that
     * produced no handled event gets no row. See the `Block` docstring in `schema.graphql`
     */
    promises.push(mapBlock(substrateEvent.block).save());
  }

  const extrinsicIdx = substrateEvent.extrinsic?.idx;

  if (extrinsicIdx !== undefined && !context.handledExtrinsics.has(extrinsicIdx)) {
    context.handledExtrinsics.add(extrinsicIdx);

    promises.push(handleExtrinsic(substrateEvent.extrinsic));
  }

  const event = handleToolingEvent(substrateEvent);
  promises.push(event.save());

  promises.push(mapExternalAgentAction(substrateEvent));

  await Promise.all(promises);
}
