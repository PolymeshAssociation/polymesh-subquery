import { SubstrateBlock } from '@subql/types';
import type { KeyRecordResolution } from '../utils/accounts';
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
   * What `identity.keyRecords` said about an address, including the addresses it said nothing
   * about.
   *
   * Safe to hold for a whole block because `api` reads the block's end-of-block state, so the
   * answer is the same for every event in it. Entity rows are not cached here - a handler can
   * link or unlink a key mid-block, so `Account` is read from the store on every lookup.
   */
  keyRecords: Map<string, KeyRecordResolution | undefined>;
  /**
   * The account that authored the block, once something has asked — `null` when it resolved to none.
   * A chain read, and the same answer for every event in the block, so it is read at most once.
   */
  author?: string | null;
  /** Whether `block.specVersion` has been checked against the runtime that executed the block */
  specChecked?: boolean;
}

let current: BlockContext | undefined;

const contextFor = (blockId: string, blockHash?: string): BlockContext => {
  const isSameBlock =
    current?.blockId === blockId &&
    (blockHash === undefined || current.blockHash === undefined || current.blockHash === blockHash);

  if (!current || !isSameBlock) {
    current = {
      blockId,
      blockHash,
      blockWritten: false,
      handledExtrinsics: new Set(),
      keyRecords: new Map(),
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
 * The key record cache for a block, reachable from layers that carry only the block id.
 */
export const getKeyRecordCache = (blockId: string): Map<string, KeyRecordResolution | undefined> =>
  contextFor(blockId).keyRecords;

const eventIndexes = new WeakMap<object, Map<number, number[]>>();

/**
 * Where extrinsic `extrinsicIdx`'s events sit in `block.events`, in order.
 *
 * Built in one pass the first time anything asks, rather than by scanning the block on every
 * question: a block of a few hundred transactions asked this once per transaction was quadratic,
 * and on testnet's busiest early blocks that alone held indexing to under a block a minute. Held
 * against the event list itself, so it lives exactly as long as the block does.
 */
export const extrinsicEventIndices = (block: SubstrateBlock, extrinsicIdx: number): number[] => {
  const events = block.events ?? [];
  let byExtrinsic = eventIndexes.get(events);

  if (!byExtrinsic) {
    const index = new Map<number, number[]>();

    events.forEach((record, position) => {
      if (!record.phase?.isApplyExtrinsic) {
        return;
      }

      const owner = record.phase.asApplyExtrinsic.toNumber();
      const positions = index.get(owner);

      if (positions) {
        positions.push(position);
      } else {
        index.set(owner, [position]);
      }
    });

    eventIndexes.set(events, index);
    byExtrinsic = index;
  }

  return byExtrinsic.get(extrinsicIdx) ?? [];
};
