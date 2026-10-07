import { SubstrateBlock } from '@subql/types';
import { getBlockContext } from './blockContext';

/**
 * Sets `block.specVersion` to the runtime that actually executed the block.
 *
 * The node labels each block with a spec version taken from the dictionary's map of spec ranges,
 * and that map starts each runtime late — by up to a few hundred blocks on testnet — while the node
 * applies one label to a whole batch it believes sits in a single runtime. Around every upgrade
 * some blocks carry the neighbouring runtime's spec: on a full testnet replay, about 2% of the
 * blocks the index touched. Everything here that branches on the spec — which decoder an event
 * uses, which era a handler reads a value as — then decides for the wrong runtime.
 *
 * The runtime that executes a block is the one its parent's state holds, and one read of that
 * answers it exactly. Done once per block, before any handler looks at the spec: the block object
 * is shared by every event and call in the block, so correcting it here corrects it for all of
 * them. Every entry point calls this first; the catch-all event handler runs ahead of the specific
 * ones because its datasource is declared first.
 *
 * What this cannot reach is the node's own `api`, which is built for the block before any handler
 * runs: on a mislabelled block its storage reads decode with the neighbouring runtime's metadata,
 * which differs only where an upgrade changed a storage layout.
 */
export const ensureTrueSpecVersion = async (block: SubstrateBlock): Promise<void> => {
  const context = getBlockContext(block);

  if (context.specChecked) {
    return;
  }

  const executedBy = await api.rpc.state.getRuntimeVersion(block.block.header.parentHash);
  const specVersion = executedBy.specVersion.toNumber();

  if (specVersion !== block.specVersion) {
    logger.info(
      `Block ${context.blockId} was labelled spec ${block.specVersion} but ran under ${specVersion}; using ${specVersion}`
    );
    (block as { specVersion: number }).specVersion = specVersion;
  }

  context.specChecked = true;
};
