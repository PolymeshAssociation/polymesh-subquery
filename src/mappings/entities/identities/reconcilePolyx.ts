import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { AccountBalance, AnomalyKind } from '../../../types';
import { getBigIntValue } from '../../../utils';
import { recordAnomaly } from '../../../utils/anomaly';
import { accountDataFrozen, recomputeDerived } from './mapPolyxLedger';

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

/** Sample rate for the routine check. `BalanceSet`/`DustLost` always reconcile regardless. */
const RECONCILE_EVERY_N_BLOCKS = 500;

const blockNumber = (block: SubstrateBlock): number => Number(block.block.header.number.toString());

const shouldSample = (block: SubstrateBlock, force: boolean): boolean =>
  force || blockNumber(block) % RECONCILE_EVERY_N_BLOCKS === 0;

interface OnChain {
  free: bigint;
  reserved: bigint;
  frozen: bigint;
}

const readOnChain = async (address: string): Promise<OnChain> => {
  const info = (await api.query.system.account(address)) as unknown as {
    data: Record<string, Codec>;
  };

  return {
    free: getBigIntValue(info.data.free),
    reserved: getBigIntValue(info.data.reserved),
    frozen: accountDataFrozen(info.data),
  };
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

  const balance = await AccountBalance.get(address);

  if (!balance) {
    return;
  }

  let onChain: OnChain;

  try {
    onChain = await readOnChain(address);
  } catch {
    // A pruned node or a transient RPC error is not a ledger defect.
    return;
  }

  const drifts: string[] = [];

  if (balance.free !== onChain.free) {
    drifts.push(`free ${balance.free} vs ${onChain.free}`);
  }
  if (balance.reserved !== onChain.reserved) {
    drifts.push(`reserved ${balance.reserved} vs ${onChain.reserved}`);
  }
  if (balance.frozen !== onChain.frozen) {
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

  // Correct the derived value so the drift cannot compound.
  balance.free = onChain.free;
  balance.reserved = onChain.reserved;
  balance.locks =
    onChain.frozen > BigInt(0)
      ? [{ lockId: 'reconciled', amount: onChain.frozen, reasons: undefined }]
      : (balance.locks ?? []).filter(lock => lock.lockId !== 'reconciled');
  recomputeDerived(balance);
  balance.updatedBlockId = blockId;

  await balance.save();
};
