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

const RECONCILE_EVERY_N_BLOCKS = 2000;

/**
 * Ignore drift below this (100 POLYX). The pre-v5.4 weight fee is charged with no event, so the
 * ledger runs a little high until this corrects it; a real mis-mapped or missed event drifts by
 * thousands of POLYX. The offline harness sums with no threshold and catches slow accumulation.
 */
const MIN_DRIFT = BigInt(100_000_000);

const abs = (value: bigint): bigint => (value < BigInt(0) ? -value : value);

const blockNumber = (block: SubstrateBlock): number => Number(block.block.header.number.toString());

const shouldSample = (block: SubstrateBlock, force: boolean): boolean =>
  force || blockNumber(block) % RECONCILE_EVERY_N_BLOCKS === 0;

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

/** Test hook — clears both the per-block RPC memo and the pending-reconcile queue. */
export const __resetOnChainCache = (): void => {
  onChainCacheBlock = -1;
  onChainCache.clear();
  pendingBlock = -1;
  pending.clear();
};

/**
 * Everything the correction needs, read while `api` is still bound to `block`.
 *
 * `holds` (v8) and the staking lock (pre-v8) are read here rather than at correction time for the
 * same reason `free`/`reserved` are: by then `api` targets a later block. Which one is read is
 * decided by the chain version, so exactly one chain read is added per sampled account.
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
    stakingLock: is8x ? undefined : await readStakingLock(address),
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
  if (!address || !shouldSample(block, force)) {
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
 * Runs every reconciliation queued by the previous block. Called from the block handler, which
 * (per `@subql/node`'s handler order) runs after the previous block's own events have finished but
 * before this block's — so the derived `AccountBalance` now reflects the previous block's final
 * state, matching the on-chain snapshot `reconcileAccount` captured back then.
 */
export const reconcileBlock = async (): Promise<void> => {
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
