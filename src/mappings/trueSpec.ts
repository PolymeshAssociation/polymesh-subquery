import { SubstrateBlock } from '@subql/types';
import { ChainUpgrade } from '../types';
import { getAllByFields } from '../utils/common';
import { getBlockContext } from './blockContext';

/**
 * The runtime in force before the first upgrade the index holds, read once per worker.
 *
 * Nothing changes it until a `ChainUpgrade` row exists to say so, and blocks are processed in
 * order, so whichever block a worker first reads it at answers for every block before that row.
 */
let initialSpec: number | undefined;

/** Test hook — the value is process-lifetime. */
export const __resetInitialSpec = (): void => {
  initialSpec = undefined;
};

/**
 * The spec the index's own `ChainUpgrade` rows say executed block `height`: the latest upgrade
 * whose `system.CodeUpdated` came in an earlier block. The block carrying it still ran the runtime
 * being replaced; the new one runs from the next. `undefined` before the first recorded upgrade.
 *
 * Read in full rather than the latest row only: a few dozen rows, and `getByFields` merges its
 * cache with the database without ordering across the two, so a one-row read can miss a newer row.
 */
const recordedSpecAt = async (height: number): Promise<number | undefined> => {
  const upgrades = await getAllByFields<ChainUpgrade>('ChainUpgrade', []);

  let latest: ChainUpgrade | undefined;
  for (const upgrade of upgrades) {
    const at = Number(upgrade.firstBlockId);
    if (at < height && (!latest || at > Number(latest.firstBlockId))) {
      latest = upgrade;
    }
  }

  return latest?.specVersionId;
};

/**
 * Sets `block.specVersion` to the runtime that actually executed the block.
 *
 * The node labels each block with a spec version taken from the dictionary's map of spec ranges,
 * and that map starts each runtime late — by up to a few hundred blocks on testnet, and sometimes
 * early — while the node applies one label to a whole batch it believes sits in a single runtime.
 * Around every upgrade some blocks carry the neighbouring runtime's spec: on a full testnet
 * replay, about 2% of the blocks the index touched. Everything here that branches on the spec —
 * which decoder an event uses, which era a handler reads a value as — then decides for the wrong
 * runtime.
 *
 * The index already records every upgrade as a `ChainUpgrade`, from the `system.CodeUpdated` the
 * dictionary always delivers, and blocks are processed strictly in order even with `--workers`
 * (only fetching runs in parallel), so an upgrade's row is written before any later block is
 * handled. The spec comes from those rows, with no chain read. This used to read the runtime at
 * every block's parent hash: two round trips each, since the sandbox downloads the whole parent
 * block to check an explicit hash.
 *
 * Done once per block, before any handler looks at the spec: the block object is shared by every
 * event and call in the block, so correcting it here corrects it for all of them. Every entry point
 * calls this first; the catch-all event handler runs ahead of the specific ones because its
 * datasource is declared first.
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

  const specVersion =
    (await recordedSpecAt(Number(block.block.header.number.toString()))) ??
    (initialSpec ??= (
      await api.rpc.state.getRuntimeVersion(block.block.header.parentHash)
    ).specVersion.toNumber());

  if (specVersion !== block.specVersion) {
    logger.info(
      `Block ${context.blockId} was labelled spec ${block.specVersion} but ran under ${specVersion}; using ${specVersion}`
    );
    (block as { specVersion: number }).specVersion = specVersion;
  }

  context.specChecked = true;
};
