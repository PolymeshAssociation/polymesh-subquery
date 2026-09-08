import { SubstrateBlock } from '@subql/types';
import { Account } from '../types';
import { padId } from '../utils/common';

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
  /** Zero padded block number, which is what most of the handler layer carries around */
  blockId: string;
  /** Set once a caller supplies the block itself. Used to notice a different block at the same height */
  blockHash?: string;
  /** Whether the `Block` row for this block has been written. The write is idempotent by id */
  blockWritten: boolean;
  /** Extrinsic indices already handled in this block */
  handledExtrinsics: Set<number>;
  /**
   * Addresses already resolved in this block, including the ones that resolved to nothing.
   *
   * Entries are shared between callers, so a caller must not mutate what it reads back.
   */
  accounts: Map<string, Account | undefined>;
}

let current: BlockContext | undefined;

const contextFor = (blockId: string, blockHash?: string): BlockContext => {
  const isSameBlock =
    current?.blockId === blockId &&
    (blockHash === undefined || current.blockHash === undefined || current.blockHash === blockHash);

  if (!isSameBlock) {
    current = {
      blockId,
      blockHash,
      blockWritten: false,
      handledExtrinsics: new Set(),
      accounts: new Map(),
    };
  } else if (blockHash !== undefined) {
    current.blockHash = blockHash;
  }

  return current;
};

/**
 * The context for `block`, discarding the previous block's.
 *
 * Handlers are invoked in block order, so holding one block at a time is enough and keeps the
 * memory bounded regardless of how long the process runs. A different hash at the same height -
 * a reorg the node replayed - also starts a fresh context.
 */
export const getBlockContext = (block: SubstrateBlock): BlockContext =>
  contextFor(padId(block.block.header.number.toString()), block.hash.toHex());

/**
 * The account resolution cache for a block, reachable from layers that carry only the block id.
 */
export const getAccountCache = (blockId: string): Map<string, Account | undefined> =>
  contextFor(blockId).accounts;
