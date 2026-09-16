import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { AccountBalance, AnomalyKind } from '../../../types';
import { getBigIntValue, padId } from '../../../utils';
import { recordAnomaly } from '../../../utils/anomaly';
import { is8xChain } from '../../../utils/common';
import { readStakingLock } from '../../../utils/staking';
import {
  accountDataFrozen,
  applyChainFreezes,
  ChainFreezes,
  readChainHolds,
  readChainStakingLock,
} from './mapPolyxLedger';

/**
 * In-flight reconciliation (D11).
 *
 * `api.query` targets the block being indexed, and `.at` is unsupported, so authoritative state
 * can only be read while that block is current — which for `@subql/node` is true for the *whole*
 * pass over a block (block handler, then that block's own init/extrinsic/finalize events all
 * share the same api context), but is no longer true once the next block starts. The block
 * handler itself runs *before* its own block's events (confirmed against
 * `@subql/node`'s `indexBlockData`), so it cannot see that block's final derived state — only the
 * previous block's.
 *
 * `reconcileAccount`, called from event handlers, therefore reads `system.account` **immediately**
 * (the api context is still correctly bound to the account's own block at that point) and queues
 * the snapshot. `reconcileBlock`, called from the block handler, runs one block later: by the time
 * block K+1's handler fires, block K's own events have all finished, so the derived
 * `AccountBalance` matches the on-chain snapshot captured back in K — without needing to re-read
 * chain state through K+1's (wrong) api context. Comparing per-event, or re-reading on-chain state
 * at flush time, both compare against the wrong side: a *partial* mid-block balance against
 * already-final `system.account` on a `%N` block that pays several validators corrects to that
 * end-of-block value and then lets the block's remaining payout events apply on top — drifting
 * each account by one reward amount per correction.
 *
 * On a mismatch it records a `BalanceReconciliationDrift` anomaly **and corrects** the derived
 * value, so drift from one missed or mis-signed event cannot compound. The offline harness
 * (`scripts/reconcile-polyx.ts`) is what answers "is the history right"; this is the safety net.
 */

/** Aim for one sampled block per this many heights, per worker. */
const RECONCILE_EVERY_N_BLOCKS = 2000;

/**
 * Ignore drift below this (100 POLYX). The pre-v5.4 weight fee is charged with no event, so the
 * ledger runs a little high until this corrects it; a real mis-mapped or missed event drifts by
 * thousands of POLYX. The offline harness sums with no threshold and catches slow accumulation.
 */
const MIN_DRIFT = BigInt(100_000_000);

const abs = (value: bigint): bigint => (value < BigInt(0) ? -value : value);

const blockNumber = (block: SubstrateBlock): number => Number(block.block.header.number.toString());

/**
 * Whether the block currently being indexed is a sample point — decided once, by the block
 * handler, before any of that block's events run.
 *
 * This used to be `height % 2000 === 0`, but the dictionary only hands a worker the blocks that
 * carry events it subscribes to — measured on a testnet genesis resync at ~1.6% of heights. So
 * almost no multiple of 2000 was ever processed, and the check sampled ~350× less often than
 * designed: 27 comparisons across ~272,000 block handlers. Measuring the *gap* since this worker's
 * last sample instead gives one sample per ~2000 heights whatever the sparsity, with nothing to
 * retune as the chain gets denser.
 *
 * Per worker, since each thread has its own copy; the workers cover disjoint ranges, so the
 * chain-wide rate is still about one per 2000 heights.
 */
let sampleThisBlock = false;
let lastSampledHeight = Number.NEGATIVE_INFINITY;

const decideSampling = (block: SubstrateBlock): void => {
  const height = blockNumber(block);

  sampleThisBlock = height - lastSampledHeight >= RECONCILE_EVERY_N_BLOCKS;

  if (sampleThisBlock) {
    lastSampledHeight = height;
  }
};

const shouldSample = (force: boolean): boolean => force || sampleThisBlock;

interface OnChain extends ChainFreezes {
  free: bigint;
  reserved: bigint;
}

let onChainCacheBlock = -1;
const onChainCache = new Map<string, OnChain>();

interface PendingEntry {
  /** First provoking event index, kept for the anomaly's provenance. */
  eventIdx: number | undefined;
  /** The block the snapshot was captured in — not the block `reconcileBlock` later runs in. */
  block: SubstrateBlock;
  onChain: OnChain;
}

/**
 * Accounts queued to reconcile, with their on-chain snapshot already captured (read while `api`
 * was still correctly bound to their block). `reconcileBlock`, called one block later, only needs
 * to wait for the derived side to catch up — see the module docstring.
 */
let pendingBlock = -1;
const pending = new Map<string, PendingEntry>();

/** Test hook — clears the per-block RPC memo, the pending queue and the liveness counters. */
export const __resetOnChainCache = (): void => {
  onChainCacheBlock = -1;
  onChainCache.clear();
  pendingBlock = -1;
  pending.clear();
  sampleThisBlock = false;
  lastSampledHeight = Number.NEGATIVE_INFINITY;
  __resetReconcileCounters();
};

/**
 * Everything the correction needs, read while `api` is still bound to `block`.
 *
 * `holds` (v8) and the staking lock (pre-v8) are read here rather than at correction time for the
 * same reason `free`/`reserved` are: by then `api` targets a later block. Which one is read is
 * decided by the chain version: pre-v8 adds the staking ledger read, v8 adds `balances.holds` and
 * `balances.locks`.
 */
const readOnChain = async (address: string, block: SubstrateBlock): Promise<OnChain> => {
  const blockHeight = blockNumber(block);

  if (blockHeight !== onChainCacheBlock) {
    onChainCacheBlock = blockHeight;
    onChainCache.clear();
  }

  const hit = onChainCache.get(address);
  if (hit) {
    return hit;
  }

  const info = await api.query.system.account(address);
  // The balance fields, not the account info around them: `frozen` is `miscFrozen`/`feeFrozen` on
  // older runtimes, so only this inner shape is read spec-agnostically.
  const data = info.data as unknown as Record<string, Codec>;
  const is8x = is8xChain(block);

  const onChain: OnChain = {
    free: getBigIntValue(data.free),
    reserved: getBigIntValue(data.reserved),
    frozen: accountDataFrozen(data),
    holds: is8x ? await readChainHolds(address) : undefined,
    // v8 reads the lock list itself: mid-migration the old `'staking '` lock is still there
    stakingLock: is8x
      ? await readChainStakingLock(address)
      : await readStakingLock(address, padId(String(blockHeight))),
  };

  onChainCache.set(address, onChain);

  return onChain;
};

/**
 * Registers `address` to be reconciled once this block's own events have finished (see the module
 * docstring). A no-op unless the block is a sample point (every Nth) or the caller forced it (a
 * `BalanceSet` / `DustLost` checkpoint). `_blockId` is unused — `reconcileOne` derives it from the
 * block — but kept so the call sites do not change.
 *
 * Reads `system.account` right away, while `api` is still correctly bound to `block` — by the
 * time `reconcileBlock` runs, `api` will be bound to a later block instead.
 */
export const reconcileAccount = async (
  address: string,
  _blockId: string,
  block: SubstrateBlock,
  { force = false, eventIdx }: { force?: boolean; eventIdx?: number } = {}
): Promise<void> => {
  if (!address || !shouldSample(force)) {
    return;
  }

  const height = blockNumber(block);
  if (height !== pendingBlock) {
    pendingBlock = height;
    pending.clear();
  }

  const existing = pending.get(address);
  if (existing) {
    // Fill in a real event index if the queueing call so far only had a forced, event-less one.
    if (existing.eventIdx === undefined && eventIdx !== undefined) {
      existing.eventIdx = eventIdx;
    }
    return;
  }

  let onChain: OnChain;
  try {
    onChain = await readOnChain(address, block);
  } catch {
    // A pruned node or a transient RPC error is not a ledger defect.
    return;
  }

  pending.set(address, { eventIdx, block, onChain });
};

/**
 * How many accounts this process has actually compared against chain state, and how many of those
 * drifted.
 *
 * A liveness signal, not a statistic. This mechanism spent its whole life returning early on a
 * guard that could never pass, and the resulting empty `IndexerAnomaly` table was read as "the
 * ledger reconciles" when it actually meant "nothing was ever checked" — the two are
 * indistinguishable from the drift count alone. Logging the denominator makes a dead reconciler
 * obvious in the sync log: `compared=0` after a run that indexed millions of blocks is a defect
 * report, whereas `compared=12043 drifted=0` is the result that was being claimed.
 */
let comparedCount = 0;
let driftedCount = 0;
let skippedStaleCount = 0;
let flushCount = 0;
let lastReportedAt = 0;

/**
 * Report every N *flushes*, not every N comparisons.
 *
 * Keyed on comparisons, the report could never fire while `compared` stayed 0 — which is the one
 * state it exists to make visible, and the same shape of un-fireable condition that left the
 * reconciler dead in the first place. Every block handler counts as a flush, so a silent
 * reconciler now says so out loud.
 */
const REPORT_EVERY_FLUSHES = 2000;

/** Test hook — the counters are process-lifetime. */
export const __resetReconcileCounters = (): void => {
  comparedCount = 0;
  driftedCount = 0;
  skippedStaleCount = 0;
  flushCount = 0;
  lastReportedAt = 0;
};

/** The running liveness tally, for assertions after a resync. */
export const reconcileStats = (): {
  compared: number;
  drifted: number;
  skippedStale: number;
} => ({
  compared: comparedCount,
  drifted: driftedCount,
  skippedStale: skippedStaleCount,
});

const maybeReport = (): void => {
  if (flushCount - lastReportedAt < REPORT_EVERY_FLUSHES) {
    return;
  }

  lastReportedAt = flushCount;

  logger.info(
    `POLYX reconciliation (D11): compared=${comparedCount} drifted=${driftedCount} ` +
      `skippedStale=${skippedStaleCount} over ${flushCount} flushes`
  );
};

/**
 * Runs every reconciliation queued by the previous block. Called from the block handler, which
 * (per `@subql/node`'s handler order) runs after the previous block's own events have finished but
 * before this block's — so the derived `AccountBalance` now reflects the previous block's final
 * state, matching the on-chain snapshot `reconcileAccount` captured back then.
 */
export const reconcileBlock = async (block?: SubstrateBlock): Promise<void> => {
  flushCount += 1;
  maybeReport();

  if (block) {
    decideSampling(block);
  }

  if (pending.size === 0) {
    return;
  }

  const queued = [...pending.entries()];
  pending.clear();
  pendingBlock = -1;

  for (const [address, entry] of queued) {
    await reconcileOne(address, entry);
  }
};

const reconcileOne = async (
  address: string,
  { eventIdx, block, onChain }: PendingEntry
): Promise<void> => {
  const balance = await AccountBalance.get(address);
  if (!balance) {
    return;
  }

  const blockId = padId(String(blockNumber(block)));

  /**
   * The snapshot is chain state at the end of `block`, so it may only be compared against a
   * derived balance that is *also* as of `block`. The flush runs from the next block handler this
   * worker reaches, and that is not reliably `block + 1`: `--workers` hands each thread a
   * contiguous *range*, and the dictionary makes those ranges sparse, so the next processed block
   * can be hundreds of heights later. If the row moved on in between, comparing the two measures
   * different points in time and "correcting" to the snapshot writes a stale balance over a newer
   * one — which is worse than not checking, because it manufactures drift rather than removing it.
   *
   * `updatedEventId` is the block/event that last wrote this row, so it dates the derived value
   * exactly. Later than the snapshot ⇒ skip; this account simply misses that sample.
   */
  const derivedAt = (balance.updatedEventId ?? '').split('/')[0];

  if (derivedAt && derivedAt > blockId) {
    skippedStaleCount += 1;
    return;
  }

  // Counted here, where a derived balance is genuinely measured against chain state — not at
  // queue time, which says only that a comparison was intended.
  comparedCount += 1;

  const drifts: string[] = [];
  if (abs(balance.free - onChain.free) >= MIN_DRIFT) {
    drifts.push(`free ${balance.free} vs ${onChain.free}`);
  }
  if (abs(balance.reserved - onChain.reserved) >= MIN_DRIFT) {
    drifts.push(`reserved ${balance.reserved} vs ${onChain.reserved}`);
  }
  if (abs(balance.frozen - onChain.frozen) >= MIN_DRIFT) {
    drifts.push(`frozen ${balance.frozen} vs ${onChain.frozen}`);
  }

  if (drifts.length === 0) {
    return;
  }

  driftedCount += 1;

  await recordAnomaly({
    kind: AnomalyKind.BalanceReconciliationDrift,
    detail: `${address}: ${drifts.join('; ')}`,
    block,
    eventIdx,
  });

  balance.free = onChain.free;
  balance.reserved = onChain.reserved;
  // Rebuilds `locks`/`holds` from the same snapshot, so `bonded` and `otherReserved` stay
  // consistent with the corrected pools — see `applyChainFreezes`.
  applyChainFreezes(balance, onChain);
  balance.updatedEventId = `${blockId}/${padId(String(eventIdx ?? 0))}`;

  await balance.save();
};
