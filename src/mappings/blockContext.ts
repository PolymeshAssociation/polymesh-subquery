import { SubstrateBlock } from '@subql/types';

/**
 * State that lives for exactly one block.
 *
 * Every field here is a cache or a within-block deduplication marker, never a decision the index
 * depends on: losing it re-does work, it does not change what is written. That is what makes it
 * safe under `--workers`, where each thread holds its own copy - a worker indexes a whole block,
 * so a block's context is never split across threads.
 *
 * Anything that must survive a block, a restart or a worker boundary belongs in an entity
 * instead. `ChainUpgrade` is the worked example: it used to be two module level variables.
 */
export interface BlockContext {
  blockHash: string;
  /** Whether the `Block` row for this block has been written. The write is idempotent by id */
  blockWritten: boolean;
  /** Extrinsic indices already handled in this block */
  handledExtrinsics: Set<number>;
}

let current: BlockContext | undefined;

/**
 * The context for `block`, discarding the previous block's.
 *
 * Handlers are invoked in block order, so holding one block at a time is enough and keeps the
 * memory bounded regardless of how long the process runs.
 */
export const getBlockContext = (block: SubstrateBlock): BlockContext => {
  const blockHash = block.hash.toHex();

  if (current?.blockHash !== blockHash) {
    current = {
      blockHash,
      blockWritten: false,
      handledExtrinsics: new Set(),
    };
  }

  return current;
};
