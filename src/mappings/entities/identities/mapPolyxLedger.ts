import { Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { decodeEvent, optionalField } from '../../../decode';
import {
  Account,
  AccountBalance,
  AnomalyKind,
  EntryDirection,
  EventIdEnum,
  HoldReason,
  Identity,
  MovementKind,
  PolyxEntry,
  PolyxPool,
} from '../../../types';
import { getBigIntValue, getTextValue, padId } from '../../../utils';
import { recordAnomaly } from '../../../utils/anomaly';
import { is8xChain } from '../../../utils/common';
import { blockAuthor } from '../../../utils/blockAuthor';
import { readRewardDestination, resolveController } from '../../../utils/staking';
import { ledgerAccount } from '../../../utils/accounts';
import { getEventParams } from '../../../utils/events';
import { extractArgs, HandlerArgs } from '../common';
import { getAccountId, systematicIssuers } from '../../consts';
import { getLedgerEntries } from '../../blockContext';
import {
  adjustHold,
  adjustLock,
  amountOf,
  bumpLifetimeByKind,
  extrinsicEmits,
  findBlockEntries,
  findExtrinsicEntries,
  firstText,
  holder,
  holdReasonOf,
  loadBalance,
  memoOf,
  nearestPreceding,
  poolTag,
  postTransition,
  previousEventId,
  recentEventIds,
  recomputeDerived,
  relabelEntry,
  stakingStash,
  startOfUtcDay,
} from './ledgerCore';
import {
  burnDisbursedReserveShare,
  clearMigratedStakingLock,
  creditBlockAuthor,
  creditFromReserve,
  creditSlashReporters,
  drawReserveFor,
  legacyRewardRecipient,
  syncMigratedStakingLock,
  syncStakingLock,
  treasuryShareAt,
} from './preV8Ledger';
import { chargedFor } from './preV54Fees';

/**
 * POLYX ledger handlers. Every balances-pallet movement decodes to a pool transition (the
 * "Event → pool transition" table in docs/implementation/02-polyx-ledger.md), which
 * `postTransition` turns into one `PolyxEntry` per account side plus a running `AccountBalance`.
 *
 * The ledger's model is in `ledgerCore.ts`; what only applies before v8 is in `preV8Ledger.ts`,
 * and the fees no event announced before v5.4 in `preV54Fees.ts`.
 */

// ---------------------------------------------------------------------------------------------
// Locks (Locked / Unlocked / Frozen / Thawed) — a floor on `free`, not a pool. No PolyxEntry.
// ---------------------------------------------------------------------------------------------

const lockHandler =
  (lockId: string, sign: bigint) =>
  async (event: SubstrateEvent): Promise<void> => {
    const { blockId, block, blockEventId } = extractArgs(event);
    const decoded = decodeEvent(event);
    const who = holder(decoded);

    if (!who) {
      return;
    }

    // Ensure the balance row exists so the lock has somewhere to live.
    await ledgerAccount(who, blockId, block.timestamp);
    const balance = await loadBalance(who, undefined, blockEventId);
    await balance.save();

    await adjustLock(who, lockId, sign * amountOf(decoded), blockEventId);
  };

/**
 * `balances.Locked` / `Unlocked` — the `LockableCurrency` floor on `free`. On v8 an `Unlocked` can
 * also be the migration of a pre-v8 staking lock to a hold (see `clearMigratedStakingLock`).
 */
export const handleBalanceLocked = lockHandler('balances', BigInt(1));

const unlockGeneric = lockHandler('balances', BigInt(-1));

export const handleBalanceUnlocked = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);

  if (
    is8xChain(args.block) &&
    (await clearMigratedStakingLock(holder(decodeEvent(event)), args.blockEventId))
  ) {
    return;
  }

  await unlockGeneric(event);
};

/** `balances.Frozen` / `Thawed` — the upstream `fungible` freeze, also a floor on `free`. */
export const handleBalanceFrozen = lockHandler('freeze', BigInt(1));
export const handleBalanceThawed = lockHandler('freeze', BigInt(-1));

/**
 * Memos seen before their paired `Transfer`, keyed by extrinsic + endpoints + amount, per block.
 *
 * A **queue** per key, not one value: one `utility.batch` can make two transfers with the same
 * endpoints and the same amount but different memos, and a single slot let the second overwrite
 * the first. Queued in emission order and consumed in the same order, which is the order the
 * paired `Transfer` events arrive in.
 */
let pendingMemoBlock: string | undefined;
let pendingMemos = new Map<string, string[]>();

const memoKey = (
  extrinsicId: string | undefined,
  from: string,
  to: string,
  amount: bigint
): string => `${extrinsicId ?? '-'}/${from}/${to}/${amount.toString()}`;

const stashPendingMemo = (
  args: HandlerArgs,
  from: string,
  to: string,
  amount: bigint,
  memo: string
): void => {
  if (pendingMemoBlock !== args.blockId) {
    pendingMemoBlock = args.blockId;
    pendingMemos = new Map();
  }

  const key = memoKey(args.extrinsicId, from, to, amount);
  const queued = pendingMemos.get(key) ?? [];

  queued.push(memo);
  pendingMemos.set(key, queued);
};

const takePendingMemo = (
  args: HandlerArgs,
  from: string,
  to: string,
  amount: bigint
): string | undefined => {
  if (pendingMemoBlock !== args.blockId) {
    return undefined;
  }

  const key = memoKey(args.extrinsicId, from, to, amount);
  const queued = pendingMemos.get(key);
  const memo = queued?.shift();

  if (queued?.length === 0) {
    pendingMemos.delete(key);
  }

  return memo;
};

// ---------------------------------------------------------------------------------------------
// Balances-pallet handlers
// ---------------------------------------------------------------------------------------------

/**
 * `balances.Endowed` — `∅ → who/Free`, the credit that brings an account into existence.
 *
 * **N2** — when the account is created by a *deposit*, the chain emits `balances.Deposit` and then
 * `balances.Endowed` for the same account and the same amount (seen live on testnet `8001010`,
 * block 25869039: `Deposit(5Gv5Tm…, 100000000000)`, `NewAccount`, `Endowed(5Gv5Tm…,
 * 100000000000)`). The deposit *is* the endowment, so crediting both started the new account at
 * twice its real balance. The deposit's `Mint` is re-filed here instead, which also leaves it
 * discoverable as the `Endowment` that a following `Transfer` pairs with.
 *
 * Matched on the extrinsic, or on the block for a deposit made from `on_initialize` — a staking
 * reward paid to an `Account` destination that does not exist yet — which has no extrinsic.
 */
export const handleBalanceEndowed = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);

  const who = holder(decoded);
  const amount = amountOf(decoded);

  // Moves nothing. Pre-v8 every dropped positive imbalance touches the block reward reserve, which,
  // empty, is recreated with `Endowed(brr, 0)` each time: 210,000 of them on a testnet resync, each
  // writing an entry and a new balance version, 27,000 for the reserve alone.
  if (amount === BigInt(0)) {
    return;
  }

  const [deposit] = args.extrinsicId
    ? findExtrinsicEntries(args, MovementKind.Mint, who, amount)
    : findBlockEntries(args.blockId, who, amount, [MovementKind.Mint]);

  if (deposit) {
    await relabelEntry(deposit, MovementKind.Endowment, args.blockEventId);
    return;
  }

  await postTransition(args, {
    to: { address: who, pool: PolyxPool.Free },
    amount,
    kind: MovementKind.Endowment,
  });
};

export const handleBalanceTransfer = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);

  const from = firstText(decoded, ['from']);
  const to = firstText(decoded, ['to']);
  const amount = amountOf(decoded);
  // Always consume the stash, even when this event carries its own memo. Pre-v8 `transfer_core`
  // emits `TransferWithMemo` *then* `Transfer`, and the `Transfer` repeats the memo itself — so
  // the stashed copy was never taken, and a later memo-less transfer between the same accounts for
  // the same amount in that extrinsic picked up a memo that was never its own.
  const stashedMemo = takePendingMemo(args, from, to, amount);
  const memo = memoOf(decoded) ?? stashedMemo;

  // An endowment pairs with exactly one transfer. Without the `counterpartyAddress` guard a
  // batch making two equal transfers to the same new account matched the first endowment twice,
  // so the second transfer posted only its debit — the recipient's second credit was lost, and
  // the endowment's counterparty and memo were overwritten by the later one.
  //
  // Outside an extrinsic, matched on the block instead, and only to the endowment the event just
  // before wrote: the balances pallet emits `Endowed` immediately ahead of its `Transfer`, and a
  // looser match would swallow a later transfer of the same amount to the account. Testnet block
  // 10,036,148 ran scheduled settlement instructions as it initialised, paying 29 new accounts,
  // and each was credited twice.
  const endowment = (
    args.extrinsicId
      ? findExtrinsicEntries(args, MovementKind.Endowment, to, amount)
      : findBlockEntries(args.blockId, to, amount, [MovementKind.Endowment]).filter(
          entry => entry.movementId === previousEventId(args)
        )
  ).find(entry => !entry.counterpartyAddress);

  if (endowment) {
    // `balances.transfer` to a fresh account emits `Endowed` (already crediting `to/Free`) and
    // `Transfer`. Enrich the endowment with the sender and post only the debit side.
    endowment.counterpartyAddress = from;
    endowment.counterpartyIdentityId = (await Account.get(from))?.identityId;

    if (memo) {
      endowment.memo = memo;
    }

    await endowment.save();

    await postTransition(args, {
      from: { address: from, pool: PolyxPool.Free },
      amount,
      kind: MovementKind.Transfer,
      memo,
      destination: to,
    });

    return;
  }

  await postTransition(args, {
    from: { address: from, pool: PolyxPool.Free },
    to: { address: to, pool: PolyxPool.Free },
    amount,
    kind: MovementKind.Transfer,
    memo,
  });
};

/**
 * `TransferWithMemo` is emitted alongside the classic `Transfer` for one `transfer_with_memo`
 * call. It is never its own movement — it only supplies the memo. If the `Transfer` was already
 * indexed this enriches it; otherwise the memo is stashed for the `Transfer` still to come.
 *
 * The memo belongs to the *movement*, so it is written to every entry sharing the
 * matched entry's `movementId` rather than only to the recipient's side, which is all the
 * account-filtered lookup could reach. Entries that already carry a memo are skipped so two
 * identical transfers in one extrinsic consume one memo each instead of both taking the first.
 */
export const handleBalanceTransferWithMemo = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);

  const from = firstText(decoded, ['from']);
  const to = firstText(decoded, ['to']);
  const amount = amountOf(decoded);
  const memo = memoOf(decoded);

  if (!memo) {
    return;
  }

  const unmemoed = findExtrinsicEntries(args, MovementKind.Transfer, to, amount).find(
    entry => !entry.memo
  );

  if (unmemoed) {
    for (const side of getLedgerEntries(args.blockId).ofMovement(unmemoed.movementId)) {
      side.memo = memo;
      await side.save();
    }

    return;
  }

  stashPendingMemo(args, from, to, amount, memo);
};

export const handleBalanceReserved = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);
  const who = holder(decoded);

  await postTransition(args, {
    from: { address: who, pool: PolyxPool.Free },
    to: { address: who, pool: PolyxPool.Reserved },
    amount: amountOf(decoded),
    kind: MovementKind.Hold,
  });
};

export const handleBalanceUnreserved = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);
  const who = holder(decoded);

  await postTransition(args, {
    from: { address: who, pool: PolyxPool.Reserved },
    to: { address: who, pool: PolyxPool.Free },
    amount: amountOf(decoded),
    kind: MovementKind.Release,
  });
};

export const handleReserveRepatriated = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);

  const from = firstText(decoded, ['from']);
  const to = firstText(decoded, ['to']);
  const status = firstText(decoded, ['destinationStatus'])?.toLowerCase();

  await postTransition(args, {
    from: { address: from, pool: PolyxPool.Reserved },
    to: {
      address: to,
      pool: status?.includes('reserved') ? PolyxPool.Reserved : PolyxPool.Free,
    },
    amount: amountOf(decoded),
    kind: MovementKind.ReserveRepatriation,
  });
};

export const handleBalanceHeld = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);

  const who = holder(decoded);
  const amount = amountOf(decoded);
  const reason = holdReasonOf(decoded) ?? HoldReason.Unknown;

  if (!who) {
    return;
  }

  await postTransition(args, {
    from: { address: who, pool: PolyxPool.Free },
    to: { address: who, pool: PolyxPool.Reserved },
    amount,
    kind: MovementKind.Hold,
    holdReason: reason,
  });

  await adjustHold(who, reason, amount, args.blockEventId);

  if (reason === HoldReason.Staking) {
    await syncMigratedStakingLock(who, args.blockEventId);
  }
};

export const handleBalanceReleased = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);

  const who = holder(decoded);
  const amount = amountOf(decoded);
  const reason = holdReasonOf(decoded) ?? HoldReason.Unknown;

  if (!who) {
    return;
  }

  await postTransition(args, {
    from: { address: who, pool: PolyxPool.Reserved },
    to: { address: who, pool: PolyxPool.Free },
    amount,
    kind: MovementKind.Release,
    holdReason: reason,
  });

  await adjustHold(who, reason, -amount, args.blockEventId);
};

export const handleBalanceBurnedHeld = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);

  const who = holder(decoded);
  const amount = amountOf(decoded);
  const reason = holdReasonOf(decoded) ?? HoldReason.Unknown;

  if (!who) {
    return;
  }

  await postTransition(args, {
    from: { address: who, pool: PolyxPool.Reserved },
    amount,
    kind: MovementKind.Slash,
    holdReason: reason,
  });

  await adjustHold(who, reason, -amount, args.blockEventId);
};

export const handleTransferOnHold = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);

  const from = firstText(decoded, ['source', 'from']);
  const to = firstText(decoded, ['dest', 'to']);
  const amount = amountOf(decoded);
  const reason = holdReasonOf(decoded);

  await postTransition(args, {
    from: { address: from, pool: PolyxPool.Reserved },
    to: { address: to, pool: PolyxPool.Reserved },
    amount,
    kind: MovementKind.ReserveRepatriation,
    holdReason: reason,
  });

  if (reason) {
    await adjustHold(from, reason, -amount, args.blockEventId);
    await adjustHold(to, reason, amount, args.blockEventId);
  }
};

/**
 * `balances.TransferAndHold { reason, source, dest, transferred }` — `source/Free → dest/Reserved`.
 *
 * The amount field is named `transferred` here, which the shared `amountOf` name list does
 * not carry, so every one of these posted 0 (and held 0). Read explicitly rather than by widening
 * that list: `transferred` appearing in some other event would then silently outrank the name that
 * event actually means. Confirmed against `pallet-balances` at `d25e171` and live mainnet
 * (`8000020`) / testnet (`8001010`) metadata.
 */
export const handleTransferAndHold = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);

  const from = firstText(decoded, ['source', 'from']);
  const to = firstText(decoded, ['dest', 'to']);
  const transferred = optionalField(decoded, 'transferred');
  const amount = transferred !== undefined ? getBigIntValue(transferred) : amountOf(decoded);
  const reason = holdReasonOf(decoded);

  await postTransition(args, {
    from: { address: from, pool: PolyxPool.Free },
    to: { address: to, pool: PolyxPool.Reserved },
    amount,
    kind: MovementKind.ReserveRepatriation,
    holdReason: reason,
  });

  if (reason) {
    await adjustHold(to, reason, amount, args.blockEventId);
  }
};

/** `Burned` / `Slashed` / `Withdraw` / `AccountBalanceBurned` — value leaves `who/Free`. */
export const handleBalanceBurned = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);

  await postTransition(args, {
    from: { address: holder(decoded), pool: PolyxPool.Free },
    amount: amountOf(decoded),
    kind: args.eventId === EventIdEnum.Slashed ? MovementKind.Slash : MovementKind.Burn,
  });
};

/**
 * `balances.Suspended` — an upstream (v8-only) event that reaps `who`'s free balance. The
 * registration pointed at a `handleBalanceSuspended` that never existed.
 */
export const handleBalanceSuspended = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);

  await postTransition(args, {
    from: { address: holder(decoded), pool: PolyxPool.Free },
    amount: amountOf(decoded),
    kind: MovementKind.Burn,
  });
};

/** `Minted` / `Deposit` / `Restored` — value enters `who/Free`. */
export const handleBalanceMinted = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);
  const who = holder(decoded);
  const amount = amountOf(decoded);

  // A v8 staking payout can emit both `staking.Rewarded` and a `balances` deposit for the same
  // POLYX. If the reward side already recorded it, this is not a second movement.
  const reward = findBlockEntries(args.blockId, who, amount, [MovementKind.StakingReward]);

  if (reward.length > 0) {
    return;
  }

  /**
   * N2, the other ordering. `fungible::Balanced::deposit` runs `increase_balance` — which is where
   * `try_mutate_account` emits `Endowed` for a new account — and only then `done_deposit`, which
   * emits `Deposit`. So on this path the endowment is already recorded and *is* this credit.
   * (`Currency::deposit_creating` emits `Deposit` inside the mutation, ahead of `Endowed`; that
   * ordering is handled in `handleBalanceEndowed`.)
   *
   * Matched on the *immediately preceding* event rather than anywhere in the block: the two are
   * adjacent by construction, and a looser match would swallow a genuine second deposit of the
   * same amount into an account created earlier in the same block.
   */
  const endowedJustBefore = findBlockEntries(args.blockId, who, amount, [
    MovementKind.Endowment,
  ]).some(entry => entry.movementId === previousEventId(args));

  if (endowedJustBefore) {
    return;
  }

  await postTransition(args, {
    to: { address: who, pool: PolyxPool.Free },
    amount,
    kind: (await isFeePaidToAuthor(event, who, amount))
      ? MovementKind.BlockAuthorFee
      : MovementKind.Mint,
  });
};

/**
 * `balances.DustLost` — account reaping. The remaining free balance is destroyed; the row was
 * never written (`DustLost: []`).
 */
export const handleDustLost = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);
  const account = firstText(decoded, ['account', 'who']);

  await postTransition(args, {
    from: { address: account, pool: PolyxPool.Free },
    amount: amountOf(decoded),
    kind: MovementKind.DustLost,
  });
};

// ---------------------------------------------------------------------------------------------
// BalanceSet — a checkpoint, not a movement
// ---------------------------------------------------------------------------------------------

export interface PoolDelta {
  pool: PolyxPool;
  delta: bigint;
}

const signOf = (delta: bigint): EntryDirection =>
  delta > BigInt(0) ? EntryDirection.Credit : EntryDirection.Debit;

/** Sets each pool to its new absolute value, returning the non-zero deltas the set produced. */
const applyBalanceSet = (
  balance: AccountBalance,
  newFree: bigint,
  newReserved: bigint | undefined
): PoolDelta[] => {
  const deltas: PoolDelta[] = [];

  const freeDelta = newFree - balance.free;
  balance.free = newFree;
  if (freeDelta !== BigInt(0)) {
    deltas.push({ pool: PolyxPool.Free, delta: freeDelta });
  }

  if (newReserved !== undefined) {
    const reservedDelta = newReserved - balance.reserved;
    balance.reserved = newReserved;
    if (reservedDelta !== BigInt(0)) {
      deltas.push({ pool: PolyxPool.Reserved, delta: reservedDelta });
    }
  }

  return deltas;
};

/**
 * Records `deltas`, already applied to `balance`'s pools, as `BalanceSetAdjustment`s: one movement
 * on the lifetime tallies and one entry per changed pool, so the account's entries still add up to
 * its balance. Saves the balance. For a balance set to a value rather than moved by an amount: a
 * `BalanceSet`.
 */
export const recordAdjustment = async (
  balance: AccountBalance,
  deltas: PoolDelta[],
  {
    block,
    blockId,
    movementId,
    params,
    entryId,
  }: {
    block: SubstrateBlock;
    blockId: string;
    movementId: string;
    params: ReturnType<typeof getEventParams>;
    entryId: (pool: PolyxPool) => string;
  }
): Promise<void> => {
  if (deltas.length > 0) {
    balance.movementCount += 1;
    for (const { delta } of deltas) {
      bumpLifetimeByKind(
        balance,
        MovementKind.BalanceSetAdjustment,
        signOf(delta),
        delta > BigInt(0) ? delta : -delta
      );
    }
  }

  recomputeDerived(balance);
  balance.updatedEventId = movementId;
  await balance.save();

  const date = startOfUtcDay(block.timestamp);

  const entries = deltas.map(({ pool, delta }) =>
    PolyxEntry.create({
      id: entryId(pool),
      movementId,
      accountId: balance.id,
      identityId: balance.identityId,
      counterpartyAddress: undefined,
      counterpartyIdentityId: undefined,
      pool,
      amount: delta,
      amountAbs: delta > BigInt(0) ? delta : -delta,
      kind: MovementKind.BalanceSetAdjustment,
      direction: signOf(delta),
      holdReason: undefined,
      memo: undefined,
      freeAfter: balance.free,
      reservedAfter: balance.reserved,
      frozenAfter: balance.frozen,
      moduleId: params.moduleId,
      callId: params.callId,
      eventId: params.eventId,
      specVersionId: block.specVersion,
      date,
      eraIndex: undefined,
      createdEventId: movementId,
      blockId,
      extrinsicId: params.extrinsicId,
    })
  );

  entries.forEach(entry => getLedgerEntries(blockId).add(entry));
  await Promise.all(entries.map(entry => entry.save()));
};

/**
 * `BalanceSet` *sets* `free` (and, pre-v8, `reserved`) to an absolute value — it is not a
 * movement of that size. The old model recorded the set value as a delta, corrupting every
 * running total after it. Here the pools are set directly and one `BalanceSetAdjustment` entry
 * per changed pool records the delta so `SUM(entries)` still reconciles to the balance.
 */
export const handleBalanceSet = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const { blockId, block, eventIdx, blockEventId } = args;
  const datetime = block.timestamp;
  const decoded = decodeEvent(event);

  const who = holder(decoded) ?? firstText(decoded, ['account']);
  const newFree = getBigIntValue(optionalField(decoded, 'free'));
  const rawReserved = optionalField(decoded, 'reserved');
  const newReserved = rawReserved !== undefined ? getBigIntValue(rawReserved) : undefined;

  if (!who) {
    // `ledgerAccount` would otherwise create and save an `Account` keyed `undefined`, and this
    // handler would go on to write an `AccountBalance` and `PolyxEntry` rows against it. A
    // `BalanceSet` naming nothing is a decode failure, not an account.
    void recordAnomaly({
      kind: AnomalyKind.MissingReferencedEntity,
      detail: `balances.${args.eventId} carried no account to set a balance on`,
      block,
      eventIdx,
    });

    return;
  }

  const account = await ledgerAccount(who, blockId, datetime);
  const balance = await loadBalance(who, account.identityId, blockEventId);

  const deltas = applyBalanceSet(balance, newFree, newReserved);
  const params = getEventParams(args);

  await recordAdjustment(balance, deltas, {
    block,
    blockId,
    movementId: blockEventId,
    params,
    entryId: pool => `${blockId}/${padId(eventIdx.toString())}/${poolTag(pool)}s`,
  });
};

// ---------------------------------------------------------------------------------------------
// Treasury and fees
// ---------------------------------------------------------------------------------------------

const identityPrimaryAccount = async (did: string | undefined): Promise<string | undefined> =>
  did ? (await Identity.get(did))?.primaryAccount : undefined;

const treasuryPalletAccount = (): string =>
  getAccountId(systematicIssuers.treasury.accountId, api.registry.chainSS58);

/**
 * `TreasuryDisbursement(authorizingDid, targetDid, targetAccount?, amount)`: who was paid and how
 * much. The first param is the committee that authorised the spend, not the source of funds, which
 * is always the treasury pallet account. `targetAccount` arrives in 5.0.0; before it the payment
 * went to the target identity's primary key.
 */
const disbursementOf = async (
  args: HandlerArgs
): Promise<{ toAddress?: string; amount: bigint; hasToAddress: boolean }> => {
  const [, rawToDid, rawTo, rawBalance] = args.params;
  const hasToAddress = args.params.length >= 4;
  const amount = getBigIntValue(hasToAddress ? rawBalance : rawTo);
  const toAddress =
    (hasToAddress ? getTextValue(rawTo) : undefined) ??
    (await identityPrimaryAccount(getTextValue(rawToDid)));

  return { toAddress, amount, hasToAddress };
};

/**
 * The entries a disbursement's own balance events already wrote, at most one per account.
 *
 * From 5.0.0 `unsafe_disbursement` pays by `Currency::transfer`, which emits
 * `balances.Transfer{treasury → recipient}` straight before this event. Matched on the block, not
 * the extrinsic: `disbursement` is root-only, so it usually runs from a PIP's enactment as the
 * block initialises, with no extrinsic at all. And on the immediately preceding event, so equal
 * payments to one recipient each take their own transfer.
 *
 * A payment to an account it creates emits `Endowed`, credited as the account's endowment, one or
 * two events back: before 5.0.0 with no `Transfer` at all (the reserve's empty `Endowed` can sit
 * between), and from 5.0.0 with the transfer's own credit taken by the endowment.
 */
const recordedDisbursementSides = (
  args: HandlerArgs,
  treasury: string,
  toAddress: string | undefined,
  amount: bigint
): PolyxEntry[] => {
  const transferSides = getLedgerEntries(args.blockId)
    .ofMovement(previousEventId(args))
    .filter(
      entry =>
        entry.kind === MovementKind.Transfer &&
        entry.amountAbs === amount &&
        ((entry.accountId === treasury && entry.counterpartyAddress === toAddress) ||
          (entry.accountId === toAddress && entry.counterpartyAddress === treasury))
    );

  const endowed = findBlockEntries(args.blockId, toAddress, amount, [MovementKind.Endowment]).find(
    entry =>
      recentEventIds(args).has(entry.movementId) &&
      (!entry.counterpartyAddress || entry.counterpartyAddress === treasury)
  );

  return endowed ? [...transferSides, endowed] : transferSides;
};

export const handleTreasuryDisbursement = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const { toAddress, amount, hasToAddress } = await disbursementOf(args);
  const treasury = treasuryPalletAccount();

  // Before 5.0.0 the event names only the target identity, whose primary key the index may lack.
  if (!toAddress) {
    await recordAnomaly({
      kind: AnomalyKind.MissingReferencedEntity,
      detail: `treasury.TreasuryDisbursement of ${amount}: the recipient's account could not be resolved, so only the treasury's debit was recorded`,
      block: args.block,
      eventIdx: args.eventIdx,
    });
  }

  const recorded = recordedDisbursementSides(args, treasury, toAddress, amount);

  // Every side already recorded is this payment's, relabelled rather than written again. Each is a
  // different account's, so they can be relabelled together.
  recorded.forEach(side => {
    side.counterpartyAddress ??= treasury;
  });
  await Promise.all(
    recorded.map(side => relabelEntry(side, MovementKind.TreasuryDisbursement, args.blockEventId))
  );

  const debited = recorded.some(entry => entry.accountId === treasury);
  const credited = recorded.some(entry => entry.accountId === toAddress);

  if (!debited || !credited) {
    await postTransition(args, {
      from: debited ? undefined : { address: treasury, pool: PolyxPool.Free },
      to: credited || !toAddress ? undefined : { address: toAddress, pool: PolyxPool.Free },
      amount,
      kind: MovementKind.TreasuryDisbursement,
      source: debited ? treasury : undefined,
      destination: credited ? toAddress : undefined,
    });
  }

  if (!hasToAddress) {
    await burnDisbursedReserveShare(args, amount);
  }
};

export const handleTreasuryReimbursement = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const [, rawBalance] = args.params;

  // `TreasuryReimbursement(payerDid, amount)` — the amount routed to the treasury out of a fee.
  // The payer's full fee is already debited where the fee is posted, so this is the treasury's
  // credit, not a refund to the payer. The rest of the fee is the block author's, credited there
  // (see `treasuryShareAt`).
  await postTransition(args, {
    to: { address: treasuryPalletAccount(), pool: PolyxPool.Free },
    amount: getBigIntValue(rawBalance),
    kind: MovementKind.TreasuryReimbursement,
  });
};

/**
 * `protocolFee.FeeCharged` and `transactionPayment.TransactionFeePaid` — `who/Free → ∅`.
 *
 * Both carry `(AccountId, Balance)` as their first two parameters at every spec version they
 * exist for (`TransactionFeePaid` adds a trailing `tip` that is not a POLYX movement), so these
 * are read positionally rather than through the shape table.
 *
 * On v8 the fee is *already* a balance movement by the time this fires. The runtime pays
 * fees through `FungibleAdapter<Balances, DealWithFees>`, so the chain emits
 * `balances.Withdraw{who, estimated}` (indexed as a `Burn`) first, then — when the estimate was
 * high — `balances.Deposit{who, estimated − actual}` refunding the payer (a `Mint`), and finally
 * this event. Posting a debit here as well charged every fee-paying account twice, drifting `free`
 * low by its lifetime fees, and `protocolFee.FeeCharged` (whose `withdraw_fee` also emits
 * `Withdraw`) behaved the same way.
 *
 * So the withdrawal is re-filed as the fee rather than a second debit being posted, and a refund
 * becomes the fee's credit side, leaving the pair netting to the fee actually charged. A runtime
 * that charges a fee with no paired `balances` event (every pre-v8 Polymesh runtime, which used
 * its own balances implementation) finds nothing to re-file and posts the debit here.
 *
 * **Subsidies.** Both events name the subsidised user, but the fee comes out of the subsidiser's
 * paying key (`withdraw_fee`'s `fee_key`, verified in protocol-fee and transaction-payment at
 * v5.4.0, v7.4.0 and v8.0.0), and on v8 that is the account the `Withdraw` names. Matching on the
 * user alone missed the withdrawal and debited the user a second time; pre-v8, a subsidised
 * protocol fee was debited from a user whose balance never moved (a testnet account 5,500 POLYX
 * low from three of them). So the withdrawal is looked for under the paying key as well, and a
 * pre-v8 protocol fee — which `check_subsidy(user, fee, None)` subsidises regardless of the call —
 * is debited from it. A pre-v8 transaction fee is subsidised for every call except the relayer's
 * own: `check_subsidy(user, fee, Some(pallet))` rejects the transaction outright for a pallet it
 * does not subsidise (the pallet list up to v6, `SubsidyCallFilter` in v7), so any such call that
 * made it into a block was subsidised — only `Relayer` is let through unsubsidised, so the user
 * can remove the paying key.
 */
export const handleTransactionFeeCharged = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const [rawWho, rawAmount] = args.params;

  const who = getTextValue(rawWho);
  const fee = getBigIntValue(rawAmount);

  // Only a v8 runtime pairs a fee with a `balances` event to re-file. Earlier runtimes used their own
  // balances implementation and emit nothing of the kind — a full testnet replay has none before
  // v8 — so looking for a withdrawal there cost store reads on every fee that could never find one.
  // Decided by whether this extrinsic emitted a withdrawal at all, not by the block's spec label
  // (see `extrinsicEmits`). The withdrawal is from the account the event names: v8 withdraws the
  // fee from `fee_key`, the subsidiser if there is one, and names `fee_key` in the event.
  const pairedWithBalanceEvents = extrinsicEmits(
    args.block,
    args.extrinsicIdx,
    'balances',
    'Withdraw'
  );
  const burns =
    pairedWithBalanceEvents && args.extrinsicId
      ? getLedgerEntries(args.blockId)
          .inExtrinsic(args.extrinsicId)
          .filter(row => row.kind === MovementKind.Burn)
      : [];

  if (pairedWithBalanceEvents) {
    if (await refileFeeWithdrawal(args, burns, who, fee)) {
      return;
    }

    // The payer's withdrawals already took the fee, with whatever else they paid for, and its
    // refund came back: its entries already come to its real change. On v8 every withdrawal for a
    // transaction goes into one credit pool (`TxPaymentCredit`): the fee estimate (`withdraw_fee`)
    // and, for an Ethereum transaction, the storage deposit limit too, withdrawn before dispatch
    // (`runtime.rs`, `deposit_txfee`). Revive pays contract deposits out of the pool, and
    // `correct_and_deposit_fee` splits what is left into the fee, to the author, and one refund to
    // the payer of everything unspent (polkadot-sdk `FungibleAdapter`, transaction-payment v8.1.2).
    // `TransactionFeePaid` only reports the fee's share, which no single withdrawal then matches
    // (testnet blocks 24,913,217 and 25,117,609). So nothing more is debited; the fee stays inside
    // those burns rather than being split out of the one refund that mixes it with the rest.
    if (burns.some(row => row.accountId === who)) {
      return;
    }
  }

  await postTransition(args, {
    from: { address: await chargedFor(args, who), pool: PolyxPool.Free },
    amount: fee,
    kind: MovementKind.Fee,
  });

  // Where the fee went. On v8 the author's `balances.Deposit` records it; before v8 the runtime paid
  // the author through its own balances implementation and emitted nothing, so every fee left the
  // payer and arrived nowhere — which the reconciler saw as validators holding more than the index
  // said, block after block. The same test as above tells the two apart.
  if (!pairedWithBalanceEvents) {
    const splitAt = args.eventId === EventIdEnum.FeeCharged ? event.idx + 1 : event.idx - 1;

    await creditBlockAuthor(args, fee, treasuryShareAt(args.block, splitAt, event.idx));
  }
};

/**
 * Whether a v8 `balances.Deposit` is the block author being paid a fee, rather than new POLYX.
 *
 * The runtime pays each fee to the author through a `Deposit` it emits at a fixed point: a
 * transaction fee's immediately before `TransactionFeePaid`, a protocol fee's immediately after
 * `FeeCharged`. Adjacency and the amount identify it; the author check rules out the one lookalike —
 * a payer's refund that happens to equal the fee, sitting in the same place when no author was paid.
 */
const isFeePaidToAuthor = async (
  event: SubstrateEvent,
  who: string,
  amount: bigint
): Promise<boolean> => {
  const records = (event.block.events ?? []) as unknown as {
    event: { section: string; method: string; data: { toString(): string }[] };
  }[];
  const amountOf = (record?: { event: { data: { toString(): string }[] } }) =>
    record?.event.data[1] !== undefined ? BigInt(record.event.data[1].toString()) : undefined;

  const next = records[event.idx + 1];
  const previous = records[event.idx - 1];
  const beforeTransactionFee =
    next?.event.section === 'transactionPayment' &&
    next.event.method === 'TransactionFeePaid' &&
    amountOf(next) === amount;
  const afterProtocolFee =
    previous?.event.section === 'protocolFee' &&
    previous.event.method === 'FeeCharged' &&
    amountOf(previous) === amount;

  if (!beforeTransactionFee && !afterProtocolFee) {
    return false;
  }

  return (await blockAuthor(event.block)) === who;
};

/**
 * Re-files `payer`'s fee withdrawal in this extrinsic, and its refund, as the fee. `false` when
 * there is none.
 *
 * A protocol fee is withdrawn by the call immediately before `FeeCharged` announces it, and is
 * exact, so it is the nearest preceding withdrawal of that amount.
 *
 * A transaction fee is withdrawn before the call runs, as an estimate, and what the chain did not
 * charge is refunded with a `Deposit` to the payer in the same extrinsic. So its withdrawal is the
 * payer's first that accounts for the fee: equal to it, or exceeding it by exactly a refund the
 * payer was deposited. Not simply the first: a withdrawal can come ahead of the fee's and be
 * returned (testnet block 25,473,580 withdrew 3,132 then the 155,668 fee, and deposited the 3,132
 * back), and an Ethereum transaction withdraws nothing first (block 25,118,132). Not simply one of
 * the fee's size either: the call itself can burn exactly the fee from the same account after the
 * fee was withdrawn, which is why the first that accounts for it is taken.
 */
const refileFeeWithdrawal = async (
  args: HandlerArgs,
  burns: PolyxEntry[],
  payer: string,
  fee: bigint
): Promise<boolean> => {
  const own = burns.filter(row => row.accountId === payer);

  if (args.eventId === EventIdEnum.FeeCharged) {
    const withdrawal = nearestPreceding(own, args);

    if (withdrawal?.amountAbs !== fee) {
      return false;
    }

    await relabelEntry(withdrawal, MovementKind.Fee, args.blockEventId);
    return true;
  }

  const refundOf = (withdrawal: PolyxEntry): PolyxEntry | undefined =>
    findExtrinsicEntries(args, MovementKind.Mint, payer, withdrawal.amountAbs - fee)[0];

  const withdrawal = [...own]
    .sort((a, b) => (a.movementId < b.movementId ? -1 : 1))
    .find(row => row.amountAbs === fee || (row.amountAbs > fee && refundOf(row)));

  if (!withdrawal) {
    return false;
  }

  await relabelEntry(withdrawal, MovementKind.Fee, args.blockEventId);

  const refund = withdrawal.amountAbs > fee ? refundOf(withdrawal) : undefined;

  if (refund) {
    await relabelEntry(refund, MovementKind.Fee, args.blockEventId);
  }

  return true;
};

// ---------------------------------------------------------------------------------------------
// Staking — era-dependent, and inverted at v8
// ---------------------------------------------------------------------------------------------

/**
 * ≤ v7.4: bonding is `set_lock(STAKING_ID, …)` — **no balance moves**. `Bonded`/`Unbonded`/
 * `Withdrawn` maintain the staking lock only, so `frozen` reflects it; they write **no
 * `PolyxEntry`**. This is a correction — the old `type: Bonded` rows asserted movements
 * that never happened.
 *
 * v8: bonding is a Hold. The balance-side movement is the paired `balances.Held{reason:Staking}`
 * / `Released` (written by the balances handlers). The `staking.*` events here become ledger
 * state only, so they must **not** write a second entry or bonds/rewards double-count.
 *
 * Verified against the pinned `polkadot-sdk` (`f4d81a0`): `bond()` deposits `staking.Bonded` and
 * then calls `ledger.bond()` → `update_stake` → `set_on_hold`, whose `done_hold` emits
 * `balances.Held{Staking}` — same call, `Bonded` first. A compounded (`Staked`) reward follows
 * the same route through `ledger.update()`, emitting `Held` after its `Deposit`.
 */

/**
 * `staking.PayoutStarted { eraIndex, validatorStash, … }` opens each payout, from v7.0, and v8 emits
 * one per page of a paged payout. The rewards after it, up to the next one, are paid for that era
 * from that validator's payout. Runtimes before v7.0 emit no such event, so their rewards have
 * neither.
 */
let payoutBlock: string | undefined;
let payoutEraIndex: number | undefined;
let payoutValidator: string | undefined;

export const handlePayoutStarted = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);
  const era = optionalField(decoded, 'eraIndex');
  const validator = optionalField(decoded, 'validatorStash');

  payoutBlock = args.blockId;
  payoutEraIndex = era !== undefined ? Number(getTextValue(era)) : undefined;
  payoutValidator = validator !== undefined ? getTextValue(validator) : undefined;
};

/**
 * The era of the payout in progress in `blockId`. Exported so `mapStakingEvent.ts` stamps the same
 * era onto `StakingEvent` rows as `PolyxEntry` gets.
 */
export const currentPayoutEra = (blockId: string): number | undefined =>
  payoutBlock === blockId ? payoutEraIndex : undefined;

/** The validator whose payout is in progress in `blockId`. */
export const currentPayoutValidator = (blockId: string): string | undefined =>
  payoutBlock === blockId ? payoutValidator : undefined;

/**
 * The account a reward was actually paid to: on v8, the `RewardDestination` that `Rewarded`
 * carries, and before it the payee read from chain (see `legacyRewardRecipient`).
 */
const rewardRecipient = async (
  decoded: Record<string, Codec>,
  stash: string | undefined,
  is8x: boolean,
  blockId: string
): Promise<{ recipient: string; restaked: boolean } | undefined> => {
  if (!stash) {
    return undefined;
  }

  if (!is8x) {
    return legacyRewardRecipient(stash, blockId);
  }

  // `dest: Staked` restakes via the paired `balances.Held{Staking}`, so no lock work here.
  const dest = optionalField(decoded, 'dest');
  const { destination, account } = readRewardDestination(
    (dest?.toJSON() ?? null) as Parameters<typeof readRewardDestination>[0]
  );

  if (destination === 'Account' && account) {
    return { recipient: account, restaked: false };
  }

  // `make_payout` still honours the deprecated `Controller` payee and pays `bonded(stash)`. A
  // stash with no controller resolves to itself; a read that fails fails the block.
  if (destination === 'Controller') {
    return { recipient: await resolveController(stash, blockId), restaked: false };
  }

  return { recipient: stash, restaked: false };
};

/**
 * `staking.Reward` / `Rewarded` — `∅ → recipient/Free`, a real movement at both eras.
 *
 * On v8 the reward is deposited to the recipient's free balance (and, for `dest: Staked`,
 * immediately held) by paired `balances` events — this relabels that `Mint` rather than writing a
 * second movement. Pre-v8 there is no paired balances event, so the credit is written here.
 */
export const handleReward = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);

  const stash = stakingStash(decoded);
  const amount = amountOf(decoded);
  const eraIndex = currentPayoutEra(args.blockId);
  const resolved = await rewardRecipient(decoded, stash, is8xChain(args.block), args.blockId);

  if (!resolved) {
    return;
  }

  const { recipient, restaked } = resolved;

  /**
   * The payout's own balance movement may already be recorded, and if so it is re-filed rather
   * than a second credit posted. Verified against both eras' `make_payout`, which mints *before*
   * emitting `Rewarded`:
   *
   * - an existing account: v8 emits `Deposit` (a `Mint` here); pre-v8 `deposit_into_existing`
   *   emits nothing at all — Polymesh's own balances pallet never had a `Deposit` event.
   * - a destination the payout creates (`RewardDestination::Account`, or the old `Controller`):
   *   pre-v8 `deposit_creating` emits only `Endowed`, and v8 `mint_creating` emits `Endowed` ahead
   *   of `Deposit` — so the credit is an `Endowment`, and matching only `Mint` counted it twice.
   *
   * Exactly one entry, the nearest preceding match: relabelling every match let two same-amount
   * rewards to one recipient in a block consume both deposits on the first event and then post a
   * third credit on the second.
   */
  const paid = nearestPreceding(
    findBlockEntries(args.blockId, recipient, amount, [MovementKind.Mint, MovementKind.Endowment]),
    args
  );

  // Pre-v8 the payout is funded from the block reward reserve first (see `reserveShare`).
  if (paid) {
    await relabelEntry(paid, MovementKind.StakingReward, args.blockEventId, { eraIndex });
    await drawReserveFor(args, paid, MovementKind.StakingReward, { eraIndex });
  } else {
    await creditFromReserve(args, recipient, amount, MovementKind.StakingReward, { eraIndex });
  }

  // Pre-v8 `Staked` payee: the reward is added to the staking lock in the same step.
  if (restaked) {
    await syncStakingLock(recipient, args);
  }
};

/**
 * `staking.Slash` / `Slashed` — a real movement at both eras, but out of a different pool.
 *
 * On v8 a staking slash is taken from the *held* balance, not from free:
 * `slashing::do_slash` → `asset::slash` → `Currency::slash(&HoldReason::Staking, …)` →
 * `hold::Balanced::slash`, which calls `decrease_balance_on_hold` and then `done_slash` — and the
 * runtime sets `DoneSlashHandler = ()`, so no `Held`/`Released` is emitted and `staking.Slashed`
 * is the only record. Debiting free left `free` understated and `reserved` (so `bonded`)
 * overstated by the slash, both permanently. Pre-v8 the bond is a lock and the slash really does
 * come out of free, so that path is unchanged.
 */
export const handleStakingSlash = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);
  const stash = stakingStash(decoded);
  const amount = amountOf(decoded);
  const is8x = is8xChain(args.block);

  await postTransition(
    args,
    {
      from: { address: stash, pool: is8x ? PolyxPool.Reserved : PolyxPool.Free },
      amount,
      kind: MovementKind.Slash,
      holdReason: is8x ? HoldReason.Staking : undefined,
    },
    { eraIndex: currentPayoutEra(args.blockId) }
  );

  if (!stash) {
    return;
  }

  if (is8x) {
    // The hold shrank with the balance, and nothing else reports it.
    await adjustHold(stash, HoldReason.Staking, -amount, args.blockEventId);
  } else {
    // A slash reduces `ledger.total`, and pre-v8 nothing else re-reads the lock — resync it.
    await syncStakingLock(stash, args);
    await creditSlashReporters(args, stash, amount);
  }
};

/**
 * `staking.Unbonded` — the unbonding queue keeps the balance locked (`ledger.total` is unchanged
 * until `withdraw_unbonded`), so the lock does not move here on either era.
 */
export const handleUnbonded = async (): Promise<void> => {
  // intentionally a no-op for the balance ledger
};
