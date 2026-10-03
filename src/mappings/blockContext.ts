import { SubstrateBlock } from '@subql/types';
import type { PolyxEntry } from '../types';
import type { KeyRecordResolution } from '../utils/accounts';
import { padId } from '../utils/common';

/**
 * The ledger entries written while a block is indexed, looked up by extrinsic, account and
 * movement: what the ledger pairs one event against another with.
 *
 * Pairing only ever matches entries of the same block or the same extrinsic, all written earlier
 * in the block by the thread indexing it, and every entry is registered here as it is written, so
 * this holds all of them. Searching the store instead cost a `getByFields` per transfer, fee and
 * deposit, and each one sorts every cached `PolyxEntry` and sends their ids to Postgres as a
 * `NOT IN` list: quadratic in a block's size. The entries are the live objects, so a relabel
 * through one is seen by every later lookup.
 */
export class LedgerEntries {
  private readonly byExtrinsicId = new Map<string, PolyxEntry[]>();
  private readonly byAccountId = new Map<string, PolyxEntry[]>();
  private readonly byMovementId = new Map<string, PolyxEntry[]>();

  add(entry: PolyxEntry): void {
    const into = (map: Map<string, PolyxEntry[]>, key: string | undefined) => {
      if (key === undefined) {
        return;
      }
      const list = map.get(key);
      if (list) {
        list.push(entry);
      } else {
        map.set(key, [entry]);
      }
    };

    into(this.byExtrinsicId, entry.extrinsicId);
    into(this.byAccountId, entry.accountId);
    into(this.byMovementId, entry.movementId);
  }

  inExtrinsic(extrinsicId: string): PolyxEntry[] {
    return this.byExtrinsicId.get(extrinsicId) ?? [];
  }

  ofAccount(accountId: string): PolyxEntry[] {
    return this.byAccountId.get(accountId) ?? [];
  }

  ofMovement(movementId: string): PolyxEntry[] {
    return this.byMovementId.get(movementId) ?? [];
  }
}

/**
 * State that lives for exactly one block.
 *
 * Every field but `ledgerEntries` is a cache or a within-block deduplication marker, never a
 * decision the index depends on: losing it re-does work, it does not change what is written.
 * `ledgerEntries` is complete instead, for the reasons on `LedgerEntries`. All of it is safe under
 * `--workers`, where each thread holds its own copy: a worker indexes a whole block, in order, so
 * a block's context is never split across threads.
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
  /** Every ledger entry written while this block is indexed (see `LedgerEntries`) */
  ledgerEntries: LedgerEntries;
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
      ledgerEntries: new LedgerEntries(),
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
 *
 * The hash is the header's. `block.hash` is the generic codec hash of the whole signed block, every
 * extrinsic included: not the block's hash, and rebuilt on every read, so in a block of 600 events
 * it cost ~5 ms a call, and this is called several times an event (testnet block 13,617,686).
 */
export const getBlockContext = (block: SubstrateBlock): BlockContext =>
  contextFor(padId(block.block.header.number.toString()), block.block.header.hash.toHex());

/** Test hook — forget the current block, so a test reusing a height starts afresh. */
export const __resetBlockContext = (): void => {
  current = undefined;
};

/** The ledger entries written in a block so far, reachable from layers that carry only its id. */
export const getLedgerEntries = (blockId: string): LedgerEntries =>
  contextFor(blockId).ledgerEntries;

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
