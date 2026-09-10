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
 * On a mismatch it records a `BalanceReconciliationDrift` anomaly **and corrects** the derived
 * value, so drift from one missed or mis-signed event cannot compound into every later balance.
 * The offline harness (`scripts/reconcile-polyx.ts`) is what answers "is the history right"; this
 * is the going-forward safety net.
 */

/**
 * Sample rate for the routine check. `BalanceSet`/`DustLost` always reconcile regardless.
 * Each sampled account costs one `system.account` RPC read; against a remote node this is the
 * dominant cost of the genesis sweep, so the interval is coarse. The safety net still catches a
 * mis-mapped event well before it can compound — a real defect drifts by thousands of POLYX and
 * shows up at the next sample; the offline harness is what proves the history exact.
 */
const RECONCILE_EVERY_N_BLOCKS = 2000;

/**
 * Ignore drift below this (100 POLYX, 6 decimals). Two things produce sub-POLYX noise that is not
 * a handler defect: the pre-v5.4 weight fee, which older Substrate charges with no event at all
 * (so the ledger cannot see it and the balance runs a little high until this corrects it); and a
 * sample landing mid-block on an account touched more than once, where the partial derived state
 * is compared against the block's final on-chain state. A real mis-mapped or missed event drifts
 * by thousands of POLYX. The offline harness sums with no threshold and catches slow accumulation.
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

/**
 * `system.account` is end-of-block state, so within one block it is the same no matter how many
 * times or how late it is read. An account touched N times in a sampled block would otherwise
 * cost N identical RPC reads; this memoises the read for the current block (the compare and
 * correct still run every call, so the last one — with the most complete derived state — wins).
 */
let onChainCacheBlock = -1;
const onChainCache = new Map<string, OnChain>();

/** Test hook — the cache is keyed only by block height, so a suite reusing one height must clear it. */
export const __resetOnChainCache = (): void => {
  onChainCacheBlock = -1;
  onChainCache.clear();
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

export const reconcileAccount = async (
  address: string,
  blockId: string,
  block: SubstrateBlock,
  { force = false, eventIdx }: { force?: boolean; eventIdx?: number } = {}
): Promise<void> => {
  if (!address || !shouldSample(block, force)) {
    return;
  }

  // the reconcile is provoked by whatever event was being processed; the block is the honest
  // granularity when the caller did not pass an event index
  const blockEventId = `${blockId}/${padId(String(eventIdx ?? 0))}`;

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

  // Correct the derived value so the drift cannot compound. `frozen` is corrected by pinning the
  // staking lock (which is nearly all of any pre-v8 account's frozen amount) to the on-chain
  // value, so later `staking.*` events keep adjusting a realistic base rather than starting over.
  balance.free = onChain.free;
  balance.reserved = onChain.reserved;
  balance.locks =
    onChain.frozen > BigInt(0)
      ? [{ lockId: STAKING_LOCK_ID, amount: onChain.frozen, reasons: 'staking' }]
      : [];
  recomputeDerived(balance);
  balance.updatedEventId = blockEventId;

  await balance.save();
};
