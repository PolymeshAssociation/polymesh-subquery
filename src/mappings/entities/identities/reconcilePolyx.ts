import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { AccountBalance, AnomalyKind } from '../../../types';
import { getBigIntValue, padId } from '../../../utils';
import { recordAnomaly } from '../../../utils/anomaly';
import { accountDataFrozen, recomputeDerived, STAKING_LOCK_ID } from './mapPolyxLedger';

/**
 * In-flight reconciliation (D11).
 *
 * `api.query` targets the block being indexed, and `.at` is unsupported, so authoritative state
 * can only be read for the current block. This compares the derived `AccountBalance` against
 * `system.account` there — every Nth block for accounts touched in that block, and always after
 * a `BalanceSet` or `DustLost`.
 *
 * The compare-and-correct is deferred to `reconcileBlock`, run from the block handler after every
 * event handler. Doing it per-event compared a *partial* mid-block balance against end-of-block
 * `system.account`, and on a `%N` block that pays several validators it corrected to those
 * end-of-block values and then let the block's remaining payout events apply on top — drifting
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

interface OnChain {
  free: bigint;
  reserved: bigint;
  frozen: bigint;
}

let onChainCacheBlock = -1;
const onChainCache = new Map<string, OnChain>();

/**
 * Accounts to reconcile at the end of the current block. `reconcileAccount` only registers the
 * intent during event handling; `reconcileBlock` does the read/compare/correct once per account,
 * against the block's fully-applied derived balance. Value is the first provoking event index,
 * kept for the anomaly's provenance.
 */
let pendingBlock = -1;
const pending = new Map<string, number | undefined>();

/** Test hook — clears both the per-block RPC memo and the pending-reconcile queue. */
export const __resetOnChainCache = (): void => {
  onChainCacheBlock = -1;
  onChainCache.clear();
  pendingBlock = -1;
  pending.clear();
};

const readOnChain = async (address: string, blockHeight: number): Promise<OnChain> => {
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

  const onChain: OnChain = {
    free: getBigIntValue(data.free),
    reserved: getBigIntValue(data.reserved),
    frozen: accountDataFrozen(data),
  };

  onChainCache.set(address, onChain);

  return onChain;
};

/**
 * Registers `address` to be reconciled at the end of `block`. A no-op unless the block is a
 * sample point (every Nth) or the caller forced it (a `BalanceSet` / `DustLost` checkpoint).
 * `_blockId` is unused — `reconcileBlock` derives it from the block — but kept so the call sites
 * do not change.
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

  if (!pending.has(address) || pending.get(address) === undefined) {
    pending.set(address, eventIdx);
  }
};

/**
 * Runs every reconciliation queued for `block`. Called from the block handler, so the derived
 * `AccountBalance` is the block's final state and lines up with end-of-block `system.account`.
 */
export const reconcileBlock = async (block: SubstrateBlock): Promise<void> => {
  if (blockNumber(block) !== pendingBlock || pending.size === 0) {
    return;
  }

  const queued = [...pending.entries()];
  pending.clear();
  pendingBlock = -1;

  const blockId = padId(String(blockNumber(block)));

  for (const [address, eventIdx] of queued) {
    await reconcileOne(address, blockId, block, eventIdx);
  }
};

const reconcileOne = async (
  address: string,
  blockId: string,
  block: SubstrateBlock,
  eventIdx: number | undefined
): Promise<void> => {
  const balance = await AccountBalance.get(address);
  if (!balance) {
    return;
  }

  let onChain: OnChain;
  try {
    onChain = await readOnChain(address, blockNumber(block));
  } catch {
    // A pruned node or a transient RPC error is not a ledger defect.
    return;
  }

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
  balance.locks =
    onChain.frozen > BigInt(0)
      ? [{ lockId: STAKING_LOCK_ID, amount: onChain.frozen, reasons: 'staking' }]
      : [];
  recomputeDerived(balance);
  balance.updatedEventId = `${blockId}/${padId(String(eventIdx ?? 0))}`;

  await balance.save();
};
