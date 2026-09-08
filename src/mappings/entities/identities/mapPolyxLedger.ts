import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import {
  Account,
  AccountBalance,
  EntryDirection,
  EventIdEnum,
  HoldReason,
  Identity,
  MovementKind,
  PolyxEntry,
  PolyxPool,
} from '../../../types';
import { bytesToString, getBigIntValue, getTextValue, padId } from '../../../utils';
import { camelToSnakeCase, is8xChain, snakeToCamelCase } from '../../../utils/common';
import { resolveLegacyRewardDestination } from '../../../utils/staking';
import { getAccountKeyType, getOrCreateAccount } from '../../../utils/accounts';
import { getEventParams } from '../../../utils/events';
import { extractArgs, HandlerArgs } from '../common';
import { reconcileAccount } from './reconcilePolyx';

/**
 * POLYX ledger — entry-centric replacement for `mapPolyxTransaction`.
 *
 * Every balances-pallet movement decodes to a pool transition (the "Event → pool transition"
 * table in docs/implementation/02-polyx-ledger.md), which this module turns into one `PolyxEntry`
 * per account-side plus a running `AccountBalance`. `BalanceSet` (a checkpoint), locks and staking
 * are layered on in the later commits of the phase.
 */

// ---------------------------------------------------------------------------------------------
// Decoded-field helpers
// ---------------------------------------------------------------------------------------------

/**
 * A decoded field, tolerating the snake_case ⇄ camelCase difference between an upstream struct
 * event (`free_balance`) and a Polymesh shape-table entry (`freeBalance`). Returns `undefined`
 * rather than letting the decode proxy throw when the field is genuinely absent.
 */
const optionalField = (decoded: Record<string, Codec>, name: string): Codec | undefined => {
  for (const candidate of new Set([name, camelToSnakeCase(name), snakeToCamelCase(name)])) {
    if (candidate in decoded) {
      return decoded[candidate];
    }
  }

  return undefined;
};

const firstText = (decoded: Record<string, Codec>, names: string[]): string | undefined => {
  for (const name of names) {
    const value = optionalField(decoded, name);

    if (value !== undefined) {
      return getTextValue(value);
    }
  }

  return undefined;
};

const holder = (decoded: Record<string, Codec>): string | undefined =>
  firstText(decoded, ['who', 'account', 'stash']);

const amountOf = (decoded: Record<string, Codec>): bigint => {
  for (const name of ['amount', 'balance', 'freeBalance', 'free', 'value', 'actualFee']) {
    const value = optionalField(decoded, name);

    if (value !== undefined) {
      return getBigIntValue(value);
    }
  }

  return BigInt(0);
};

const holdReasonOf = (decoded: Record<string, Codec>): HoldReason | undefined => {
  const raw = optionalField(decoded, 'reason');

  if (raw === undefined) {
    return undefined;
  }

  const key = getTextValue(raw)?.toLowerCase();
  const match = Object.values(HoldReason).find(member => member.toLowerCase() === key);

  return match ?? HoldReason.Unknown;
};

const memoOf = (decoded: Record<string, Codec>): string | undefined => {
  const raw = optionalField(decoded, 'memo');

  return raw !== undefined ? bytesToString(raw) : undefined;
};

const startOfUtcDay = (datetime: Date): Date =>
  new Date(Date.UTC(datetime.getUTCFullYear(), datetime.getUTCMonth(), datetime.getUTCDate()));

const floorZero = (value: bigint): bigint => (value > BigInt(0) ? value : BigInt(0));

/**
 * `frozen` from an on-chain `AccountData`: `{ free, reserved, frozen, flags }` on v8,
 * `{ free, reserved, miscFrozen, feeFrozen }` (frozen is the max of the two) on ≤ v7.4.
 */
export const accountDataFrozen = (data: Record<string, Codec>): bigint => {
  if (data.frozen !== undefined) {
    return getBigIntValue(data.frozen);
  }

  const misc = getBigIntValue(data.miscFrozen);
  const fee = getBigIntValue(data.feeFrozen);

  return misc > fee ? misc : fee;
};

// ---------------------------------------------------------------------------------------------
// Account / balance state
// ---------------------------------------------------------------------------------------------

/**
 * The `Account` a POLYX-holding address belongs to.
 *
 * `getOrCreateAccount` covers every address the chain has a key record for. A pallet or system
 * address (the treasury pot, the block-reward pot, …) holds POLYX without being a key, so a bare
 * `Account` is created for it — `PolyxEntry.account` and `AccountBalance.account` are non-null
 * relations and the account page query is keyed on them.
 */
export const ledgerAccount = async (
  address: string,
  blockId: string,
  datetime: Date
): Promise<Account> => {
  const resolved = await getOrCreateAccount(address, blockId, datetime);

  if (resolved) {
    return resolved;
  }

  const account = Account.create({
    id: address,
    address,
    eventId: EventIdEnum.AccountCreated,
    datetime,
    ...getAccountKeyType(address),
    createdBlockId: blockId,
    updatedBlockId: blockId,
  });

  await account.save();

  return account;
};

export const emptyBalance = (
  address: string,
  identityId: string | undefined,
  blockId: string
): AccountBalance =>
  AccountBalance.create({
    id: address,
    accountId: address,
    identityId,
    free: BigInt(0),
    reserved: BigInt(0),
    frozen: BigInt(0),
    total: BigInt(0),
    transferable: BigInt(0),
    bonded: BigInt(0),
    otherReserved: BigInt(0),
    totalReceived: BigInt(0),
    totalSent: BigInt(0),
    totalFeesPaid: BigInt(0),
    totalRewards: BigInt(0),
    totalSlashed: BigInt(0),
    movementCount: 0,
    lifetimeByKind: [],
    locks: [],
    holds: [],
    updatedBlockId: blockId,
  });

export const loadBalance = async (
  address: string,
  identityId: string | undefined,
  blockId: string
): Promise<AccountBalance> => {
  const existing = await AccountBalance.get(address);

  if (existing) {
    if (!existing.identityId && identityId) {
      existing.identityId = identityId;
    }

    return existing;
  }

  return emptyBalance(address, identityId, blockId);
};

/** Pre-v8 staking bonds via a lock with this identifier; v8 bonds via a `Staking` hold. */
export const STAKING_LOCK_ID = 'staking ';

/**
 * Recomputes every field that is a pure function of the pools, `locks` and `holds`:
 *
 * - `frozen` is the **MAX** over active locks, never a sum — the property the old model could not
 *   represent.
 * - `bonded` is the staking lock (≤ v7.4) or the `Staking` hold (v8).
 * - `total = free + reserved`; `transferable = free - frozen`, floored at 0.
 */
export const recomputeDerived = (balance: AccountBalance): void => {
  const locks = balance.locks ?? [];
  const holds = balance.holds ?? [];

  const stakingHold = holds.find(hold => hold.reason === HoldReason.Staking)?.amount ?? BigInt(0);
  const stakingLock = locks.find(lock => lock.lockId === STAKING_LOCK_ID)?.amount ?? BigInt(0);

  balance.frozen = locks.reduce((max, lock) => (lock.amount > max ? lock.amount : max), BigInt(0));
  balance.bonded = stakingHold > stakingLock ? stakingHold : stakingLock;
  balance.otherReserved = floorZero(balance.reserved - stakingHold);
  balance.total = balance.free + balance.reserved;
  balance.transferable = floorZero(balance.free - balance.frozen);
};

const bumpLifetimeByKind = (
  balance: AccountBalance,
  kind: MovementKind,
  direction: EntryDirection,
  amountAbs: bigint
): void => {
  const totals = balance.lifetimeByKind ?? [];
  const signed = direction === EntryDirection.Credit ? amountAbs : -amountAbs;
  const entry = totals.find(total => total.kind === kind);

  if (entry) {
    entry.totalAbs += amountAbs;
    entry.net += signed;
    entry.count += 1;
  } else {
    totals.push({ kind, totalAbs: amountAbs, net: signed, count: 1 });
  }

  balance.lifetimeByKind = totals;
};

// ---------------------------------------------------------------------------------------------
// Pool transition → entries + balance mutation
// ---------------------------------------------------------------------------------------------

interface Endpoint {
  address: string;
  pool: PolyxPool;
}

interface Transition {
  /** debit side; absent when value entered the system (mint, endow, reward) */
  from?: Endpoint;
  /** credit side; absent when value left the system (burn, slash, fee, dust) */
  to?: Endpoint;
  amount: bigint;
  kind: MovementKind;
  holdReason?: HoldReason;
  memo?: string;
}

const poolTag = (pool: PolyxPool): string => (pool === PolyxPool.Free ? 'f' : 'r');

/**
 * Writes the entries for one pool transition and advances every touched `AccountBalance`.
 *
 * Sibling entries of one movement share `movementId` (the block/event id). Each entry carries the
 * balance-after snapshot, so Balance History is a pure index scan.
 */
export const postTransition = async (
  args: HandlerArgs,
  transition: Transition,
  options: { eraIndex?: number } = {}
): Promise<void> => {
  if (!transition.from && !transition.to) {
    return;
  }

  const { blockId, block, eventIdx, blockEventId } = args;
  const datetime = block.timestamp;
  const params = getEventParams(args);
  const date = startOfUtcDay(datetime);

  const isInternal =
    transition.from !== undefined &&
    transition.to !== undefined &&
    transition.from.address === transition.to.address;

  const sides: Array<{ endpoint: Endpoint; direction: EntryDirection; counterparty?: string }> = [];

  if (transition.from?.address) {
    sides.push({
      endpoint: transition.from,
      direction: EntryDirection.Debit,
      counterparty: transition.to?.address,
    });
  }

  if (transition.to?.address) {
    sides.push({
      endpoint: transition.to,
      direction: EntryDirection.Credit,
      counterparty: transition.from?.address,
    });
  }

  for (const side of sides) {
    const { address, pool } = side.endpoint;
    const signed =
      side.direction === EntryDirection.Credit ? transition.amount : -transition.amount;

    const account = await ledgerAccount(address, blockId, datetime);
    const balance = await loadBalance(address, account.identityId, blockId);

    if (pool === PolyxPool.Free) {
      balance.free += signed;
    } else {
      balance.reserved += signed;
    }

    if (!isInternal) {
      if (side.direction === EntryDirection.Credit) {
        balance.totalReceived += transition.amount;
      } else {
        balance.totalSent += transition.amount;
      }
    }

    if (transition.kind === MovementKind.Fee) {
      balance.totalFeesPaid += transition.amount;
    } else if (transition.kind === MovementKind.StakingReward) {
      balance.totalRewards += transition.amount;
    } else if (transition.kind === MovementKind.Slash) {
      balance.totalSlashed += transition.amount;
    }

    bumpLifetimeByKind(balance, transition.kind, side.direction, transition.amount);
    balance.movementCount += 1;
    recomputeDerived(balance);
    balance.updatedBlockId = blockId;

    await balance.save();

    const counterpartyAccount = side.counterparty
      ? await Account.get(side.counterparty)
      : undefined;

    await PolyxEntry.create({
      id: `${blockId}/${padId(eventIdx.toString())}/${poolTag(pool)}${
        side.direction === EntryDirection.Debit ? 'd' : 'c'
      }`,
      movementId: blockEventId,
      accountId: address,
      identityId: account.identityId,
      counterpartyAddress: side.counterparty,
      counterpartyIdentityId: counterpartyAccount?.identityId,
      pool,
      amount: signed,
      amountAbs: transition.amount,
      kind: transition.kind,
      direction: side.direction,
      holdReason: transition.holdReason,
      memo: transition.memo,
      freeAfter: balance.free,
      reservedAfter: balance.reserved,
      frozenAfter: balance.frozen,
      moduleId: params.moduleId,
      callId: params.callId,
      eventId: params.eventId,
      specVersionId: block.specVersion,
      date,
      eraIndex: options.eraIndex,
      createdEventId: blockEventId,
      extrinsicId: params.extrinsicId,
      eventIdx,
      datetime,
      createdBlockId: blockId,
    }).save();

    await reconcileAccount(address, blockId, block, { eventIdx });
  }
};

/**
 * v8-only hold tracking. `Held`/`Released`/`BurnedHeld` move the balance through `postTransition`;
 * this keeps the per-reason breakdown in `AccountBalance.holds` so `bonded`/`otherReserved` stay
 * derivable without a scan. On a v8 chain `SUM(holds) == reserved`.
 */
const adjustHold = async (
  address: string,
  reason: HoldReason,
  delta: bigint,
  blockId: string
): Promise<void> => {
  const balance = await AccountBalance.get(address);

  if (!balance) {
    return;
  }

  const holds = balance.holds ?? [];
  const entry = holds.find(hold => hold.reason === reason);

  if (entry) {
    entry.amount = floorZero(entry.amount + delta);
  } else if (delta > BigInt(0)) {
    holds.push({ reason, amount: delta });
  }

  balance.holds = holds.filter(hold => hold.amount > BigInt(0));
  recomputeDerived(balance);
  balance.updatedBlockId = blockId;

  await balance.save();
};

// ---------------------------------------------------------------------------------------------
// Locks (Locked / Unlocked / Frozen / Thawed) — a floor on `free`, not a pool. No PolyxEntry.
// ---------------------------------------------------------------------------------------------

/**
 * Adjusts one lock on `address` by `delta`, then recomputes `frozen = MAX(active locks)`.
 *
 * Locks aggregate by maximum, not by sum: two overlapping locks of 100 and 150 leave
 * `frozen = 150`. This is why each lock is tracked individually in `AccountBalance.locks` rather
 * than folded into a single number.
 *
 * PIPs vote locks (`PIPS_LOCK_ID`) are not wired here — the pips pallet emits no lock/unlock
 * event, only `Voted`, and attributing the deposit needs the proposal-deposit model. Follow-up.
 */
export const adjustLock = async (
  address: string,
  lockId: string,
  delta: bigint,
  blockId: string,
  reasons?: string
): Promise<void> => {
  const balance = await AccountBalance.get(address);

  if (!balance) {
    return;
  }

  const locks = balance.locks ?? [];
  const entry = locks.find(lock => lock.lockId === lockId);

  if (entry) {
    entry.amount = floorZero(entry.amount + delta);
    if (reasons !== undefined) {
      entry.reasons = reasons;
    }
  } else if (delta > BigInt(0)) {
    locks.push({ lockId, amount: delta, reasons });
  }

  balance.locks = locks.filter(lock => lock.amount > BigInt(0));
  recomputeDerived(balance);
  balance.updatedBlockId = blockId;

  await balance.save();
};

/** Sets one lock on `address` to an absolute amount (0 clears it). */
export const setLock = async (
  address: string,
  lockId: string,
  amount: bigint,
  blockId: string,
  reasons?: string
): Promise<void> => {
  const balance = await AccountBalance.get(address);
  const current = balance?.locks?.find(lock => lock.lockId === lockId)?.amount ?? BigInt(0);

  await adjustLock(address, lockId, amount - current, blockId, reasons);
};

const lockHandler =
  (lockId: string, sign: bigint) =>
  async (event: SubstrateEvent): Promise<void> => {
    const { blockId, block } = extractArgs(event);
    const decoded = decodeEvent(event);
    const who = holder(decoded);

    if (!who) {
      return;
    }

    // Ensure the balance row exists so the lock has somewhere to live.
    await ledgerAccount(who, blockId, block.timestamp);
    const balance = await loadBalance(who, undefined, blockId);
    await balance.save();

    await adjustLock(who, lockId, sign * amountOf(decoded), blockId);
  };

/** `balances.Locked` / `Unlocked` — the `LockableCurrency` floor on `free`. */
export const handleBalanceLocked = lockHandler('balances', BigInt(1));
export const handleBalanceUnlocked = lockHandler('balances', BigInt(-1));
/** `balances.Frozen` / `Thawed` — the upstream `fungible` freeze, also a floor on `free`. */
export const handleBalanceFrozen = lockHandler('freeze', BigInt(1));
export const handleBalanceThawed = lockHandler('freeze', BigInt(-1));

// ---------------------------------------------------------------------------------------------
// Cross-event pairing helpers
// ---------------------------------------------------------------------------------------------

/** Memos seen before their paired `Transfer`, keyed by extrinsic + endpoints + amount, per block. */
let pendingMemoBlock: string | undefined;
let pendingMemos = new Map<string, string>();

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

  pendingMemos.set(memoKey(args.extrinsicId, from, to, amount), memo);
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
  const memo = pendingMemos.get(key);

  if (memo !== undefined) {
    pendingMemos.delete(key);
  }

  return memo;
};

/**
 * Entries already written in this extrinsic for `(kind, account)`, narrowed to `amountAbs` here.
 *
 * `store.getByFields` reads the write cache before the database, so a row saved earlier in this
 * block is visible. Only indexed fields can go in the filter (`amountAbs` is not one — the schema
 * is at the 10-index cap), so the amount match is applied in memory.
 */
const findExtrinsicEntries = async (
  args: HandlerArgs,
  kind: MovementKind,
  account: string | undefined,
  amountAbs: bigint
): Promise<PolyxEntry[]> => {
  if (!args.extrinsicId || !account) {
    return [];
  }

  const rows = await PolyxEntry.getByFields(
    [
      ['extrinsicId', '=', args.extrinsicId],
      ['kind', '=', kind],
      ['accountId', '=', account],
    ],
    { limit: 50 }
  );

  return rows.filter(row => row.amountAbs === amountAbs);
};

/**
 * Entries written earlier in this block for `account` of one of `kinds`, narrowed to `amountAbs`.
 *
 * Staking rewards arrive from `on_initialize`, not an extrinsic, so the reward event and any
 * paired `balances` deposit can only be matched on the block. Used to keep a v8 reward from being
 * counted twice — once as `Mint`, once as `StakingReward`.
 */
const findBlockEntries = async (
  blockId: string,
  account: string | undefined,
  amountAbs: bigint,
  kinds: MovementKind[]
): Promise<PolyxEntry[]> => {
  if (!account) {
    return [];
  }

  const rows = await PolyxEntry.getByFields(
    [
      ['createdBlockId', '=', blockId],
      ['accountId', '=', account],
    ],
    { limit: 100 }
  );

  return rows.filter(row => kinds.includes(row.kind) && row.amountAbs === amountAbs);
};

// ---------------------------------------------------------------------------------------------
// Balances-pallet handlers
// ---------------------------------------------------------------------------------------------

export const handleBalanceEndowed = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);

  await postTransition(args, {
    to: { address: holder(decoded), pool: PolyxPool.Free },
    amount: amountOf(decoded),
    kind: MovementKind.Endowment,
  });
};

export const handleBalanceTransfer = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);

  const from = firstText(decoded, ['from']);
  const to = firstText(decoded, ['to']);
  const amount = amountOf(decoded);
  const memo = memoOf(decoded) ?? takePendingMemo(args, from, to, amount);

  const [endowment] = await findExtrinsicEntries(args, MovementKind.Endowment, to, amount);

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
 * A2: `TransferWithMemo` is emitted alongside the classic `Transfer` for one `transfer_with_memo`
 * call. It is never its own movement — it only supplies the memo. If the `Transfer` was already
 * indexed this enriches it; otherwise the memo is stashed for the `Transfer` still to come.
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

  const existing = await findExtrinsicEntries(args, MovementKind.Transfer, to, amount);

  if (existing.length > 0) {
    for (const entry of existing) {
      entry.memo = memo;
      await entry.save();
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

  await postTransition(args, {
    from: { address: who, pool: PolyxPool.Free },
    to: { address: who, pool: PolyxPool.Reserved },
    amount,
    kind: MovementKind.Hold,
    holdReason: reason,
  });

  await adjustHold(who, reason, amount, args.blockId);
};

export const handleBalanceReleased = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);

  const who = holder(decoded);
  const amount = amountOf(decoded);
  const reason = holdReasonOf(decoded) ?? HoldReason.Unknown;

  await postTransition(args, {
    from: { address: who, pool: PolyxPool.Reserved },
    to: { address: who, pool: PolyxPool.Free },
    amount,
    kind: MovementKind.Release,
    holdReason: reason,
  });

  await adjustHold(who, reason, -amount, args.blockId);
};

export const handleBalanceBurnedHeld = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);

  const who = holder(decoded);
  const amount = amountOf(decoded);
  const reason = holdReasonOf(decoded) ?? HoldReason.Unknown;

  await postTransition(args, {
    from: { address: who, pool: PolyxPool.Reserved },
    amount,
    kind: MovementKind.Slash,
    holdReason: reason,
  });

  await adjustHold(who, reason, -amount, args.blockId);
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
    await adjustHold(from, reason, -amount, args.blockId);
    await adjustHold(to, reason, amount, args.blockId);
  }
};

export const handleTransferAndHold = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);

  const from = firstText(decoded, ['source', 'from']);
  const to = firstText(decoded, ['dest', 'to']);
  const amount = amountOf(decoded);
  const reason = holdReasonOf(decoded);

  await postTransition(args, {
    from: { address: from, pool: PolyxPool.Free },
    to: { address: to, pool: PolyxPool.Reserved },
    amount,
    kind: MovementKind.ReserveRepatriation,
    holdReason: reason,
  });

  if (reason) {
    await adjustHold(to, reason, amount, args.blockId);
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
 * A3: `balances.Suspended` — an upstream (v8-only) event that reaps `who`'s free balance. The
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
  const reward = await findBlockEntries(args.blockId, who, amount, [MovementKind.StakingReward]);

  if (reward.length > 0) {
    return;
  }

  await postTransition(args, {
    to: { address: who, pool: PolyxPool.Free },
    amount,
    kind: MovementKind.Mint,
  });
};

/**
 * A9: `balances.DustLost` — account reaping. The remaining free balance is destroyed; the row was
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

  // account reaping — always reconcile the reaped account against chain state
  await reconcileAccount(account, args.blockId, args.block, {
    force: true,
    eventIdx: args.eventIdx,
  });
};

// ---------------------------------------------------------------------------------------------
// BalanceSet — a checkpoint, not a movement (resolves A1 structurally)
// ---------------------------------------------------------------------------------------------

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

  const account = await ledgerAccount(who, blockId, datetime);
  const balance = await loadBalance(who, account.identityId, blockId);

  const deltas: Array<{ pool: PolyxPool; delta: bigint }> = [];

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

  if (deltas.length > 0) {
    balance.movementCount += 1;
    for (const { delta } of deltas) {
      bumpLifetimeByKind(
        balance,
        MovementKind.BalanceSetAdjustment,
        delta > BigInt(0) ? EntryDirection.Credit : EntryDirection.Debit,
        delta > BigInt(0) ? delta : -delta
      );
    }
  }

  recomputeDerived(balance);
  balance.updatedBlockId = blockId;
  await balance.save();

  const params = getEventParams(args);
  const date = startOfUtcDay(datetime);

  for (const { pool, delta } of deltas) {
    await PolyxEntry.create({
      id: `${blockId}/${padId(eventIdx.toString())}/${poolTag(pool)}s`,
      movementId: blockEventId,
      accountId: who,
      identityId: account.identityId,
      counterpartyAddress: undefined,
      counterpartyIdentityId: undefined,
      pool,
      amount: delta,
      amountAbs: delta > BigInt(0) ? delta : -delta,
      kind: MovementKind.BalanceSetAdjustment,
      direction: delta > BigInt(0) ? EntryDirection.Credit : EntryDirection.Debit,
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
      createdEventId: blockEventId,
      extrinsicId: params.extrinsicId,
      eventIdx,
      datetime,
      createdBlockId: blockId,
    }).save();
  }

  // a checkpoint should equal chain state — always reconcile right after it
  await reconcileAccount(who, blockId, block, { force: true, eventIdx });
};

// ---------------------------------------------------------------------------------------------
// Treasury and fees
// ---------------------------------------------------------------------------------------------

const identityPrimaryAccount = async (did: string | undefined): Promise<string | undefined> =>
  did ? (await Identity.get(did))?.primaryAccount : undefined;

export const handleTreasuryDisbursement = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const [rawFromDid, rawToDid, rawTo, rawBalance] = args.params;

  // (IdentityId, IdentityId, AccountId, Balance) from 5.0.0; (IdentityId, IdentityId, Balance) before
  const hasToAddress = args.params.length >= 4;
  const amount = getBigIntValue(hasToAddress ? rawBalance : rawTo);
  const fromAddress = await identityPrimaryAccount(getTextValue(rawFromDid));
  const toAddress =
    (hasToAddress ? getTextValue(rawTo) : undefined) ??
    (await identityPrimaryAccount(getTextValue(rawToDid)));

  const [existingTransfer] = await findExtrinsicEntries(
    args,
    MovementKind.Transfer,
    toAddress,
    amount
  );

  if (existingTransfer) {
    // `treasury.disbursement` to an identity emits both `Transfer` and `TreasuryDisbursement`;
    // relabel the transfer rather than double-counting.
    existingTransfer.kind = MovementKind.TreasuryDisbursement;
    await existingTransfer.save();

    return;
  }

  await postTransition(args, {
    from: fromAddress ? { address: fromAddress, pool: PolyxPool.Free } : undefined,
    to: toAddress ? { address: toAddress, pool: PolyxPool.Free } : undefined,
    amount,
    kind: MovementKind.TreasuryDisbursement,
  });
};

export const handleTreasuryReimbursement = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const [rawIdentity, rawBalance] = args.params;
  const { specVersion } = args.block;

  // Until 5.4.1 the event reported 80% of the amount actually taken from the payer.
  const reported = getBigIntValue(rawBalance);
  const amount = specVersion < 5004001 ? (reported * BigInt(125)) / BigInt(100) : reported;

  const treasury = await identityPrimaryAccount(getTextValue(rawIdentity));

  await postTransition(args, {
    to: treasury ? { address: treasury, pool: PolyxPool.Free } : undefined,
    amount,
    kind: MovementKind.TreasuryReimbursement,
  });
};

/**
 * `protocolFee.FeeCharged` and `transactionPayment.TransactionFeePaid` — `who/Free → ∅`.
 *
 * Both carry `(AccountId, Balance)` as their first two parameters at every spec version they
 * exist for (`TransactionFeePaid` adds a trailing `tip` that is not a POLYX movement), so these
 * are read positionally rather than through the shape table.
 */
export const handleTransactionFeeCharged = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const [rawWho, rawAmount] = args.params;

  await postTransition(args, {
    from: { address: getTextValue(rawWho), pool: PolyxPool.Free },
    amount: getBigIntValue(rawAmount),
    kind: MovementKind.Fee,
  });
};

// ---------------------------------------------------------------------------------------------
// Staking — era-dependent, and inverted at v8 (defect A10, resolves A6)
// ---------------------------------------------------------------------------------------------

/**
 * ≤ v7.4: bonding is `set_lock(STAKING_ID, …)` — **no balance moves**. `Bonded`/`Unbonded`/
 * `Withdrawn` maintain the staking lock only, so `frozen` reflects it; they write **no
 * `PolyxEntry`**. This is the A6 correction — the old `type: Bonded` rows asserted movements
 * that never happened.
 *
 * v8: bonding is a Hold. The balance-side movement is the paired `balances.Held{reason:Staking}`
 * / `Released` (written by the balances handlers). The `staking.*` events here become ledger
 * state only, so they must **not** write a second entry or bonds/rewards double-count.
 *
 * NOT YET VERIFIED against a real v8 block: that `staking.Bonded` and `balances.Held{Staking}`
 * are emitted within one extrinsic. If that pairing does not hold, v8 bonded POLYX is unindexed
 * and this assumption must change — the reconciliation harness is designed to catch it.
 */

/** `staking.PayoutStarted { eraIndex, validatorStash, … }` precedes the payout's `Rewarded` events. */
let payoutEraBlock: string | undefined;
let payoutEraIndex: number | undefined;

export const handlePayoutStarted = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);
  const raw = optionalField(decoded, 'eraIndex');

  payoutEraBlock = args.blockId;
  payoutEraIndex = raw !== undefined ? Number(getTextValue(raw)) : undefined;
};

const currentPayoutEra = (blockId: string): number | undefined =>
  payoutEraBlock === blockId ? payoutEraIndex : undefined;

const stakingStash = (decoded: Record<string, Codec>): string | undefined =>
  firstText(decoded, ['stash', 'account', 'staker', 'who']);

/**
 * The account a reward was actually paid to.
 *
 * v8: the `Rewarded` event carries the `RewardDestination`. Pre-v8 it carries only the stash, so
 * `staking.payee(stash)` is read from chain storage (A15) — measured on mainnet to matter for a
 * large share of pre-v8 rewards.
 */
const rewardRecipient = async (
  decoded: Record<string, Codec>,
  stash: string | undefined,
  is8x: boolean
): Promise<string | undefined> => {
  if (!stash) {
    return undefined;
  }

  if (is8x) {
    const dest = optionalField(decoded, 'dest');
    const json = dest?.toJSON() as string | Record<string, unknown> | undefined;

    if (json && typeof json === 'object') {
      return ((json.account ?? json.Account) as string | undefined) ?? stash;
    }

    return stash;
  }

  const { rewardDestinationAccount } = await resolveLegacyRewardDestination(stash);

  return rewardDestinationAccount ?? stash;
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
  const recipient = await rewardRecipient(decoded, stash, is8xChain(args.block));

  if (!recipient) {
    return;
  }

  // If a `balances` deposit for this reward was already recorded as a plain mint, relabel it.
  const mints = await findBlockEntries(args.blockId, recipient, amount, [MovementKind.Mint]);

  if (mints.length > 0) {
    for (const mint of mints) {
      mint.kind = MovementKind.StakingReward;
      mint.eraIndex = eraIndex;
      await mint.save();
    }

    const balance = await AccountBalance.get(recipient);
    if (balance) {
      balance.totalRewards += amount;
      await balance.save();
    }

    return;
  }

  await postTransition(
    args,
    {
      to: { address: recipient, pool: PolyxPool.Free },
      amount,
      kind: MovementKind.StakingReward,
    },
    { eraIndex }
  );
};

/** `staking.Slash` / `Slashed` — `staker/Free → ∅`, a real movement at both eras. */
export const handleStakingSlash = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const decoded = decodeEvent(event);

  await postTransition(
    args,
    {
      from: { address: stakingStash(decoded), pool: PolyxPool.Free },
      amount: amountOf(decoded),
      kind: MovementKind.Slash,
    },
    { eraIndex: currentPayoutEra(args.blockId) }
  );
};

const ensureBalanceRow = async (
  address: string,
  blockId: string,
  datetime: Date
): Promise<void> => {
  await ledgerAccount(address, blockId, datetime);
  const balance = await loadBalance(address, undefined, blockId);
  await balance.save();
};

/** `staking.Bonded` — pre-v8 raises the staking lock; v8 is ledger state only (see `Held`). */
export const handleBonded = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);

  if (is8xChain(args.block)) {
    return;
  }

  const decoded = decodeEvent(event);
  const stash = stakingStash(decoded);

  if (!stash) {
    return;
  }

  await ensureBalanceRow(stash, args.blockId, args.block.timestamp);
  await adjustLock(stash, STAKING_LOCK_ID, amountOf(decoded), args.blockId, 'staking');
};

/**
 * `staking.Unbonded` — the unbonding queue keeps the balance locked (`ledger.total` is unchanged
 * until `withdraw_unbonded`), so the lock does not move here on either era.
 */
export const handleUnbonded = async (): Promise<void> => {
  // intentionally a no-op for the balance ledger
};

/** `staking.Withdrawn` — pre-v8 lowers the staking lock as matured chunks leave; v8 is state only. */
export const handleWithdrawn = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);

  if (is8xChain(args.block)) {
    return;
  }

  const decoded = decodeEvent(event);
  const stash = stakingStash(decoded);

  if (!stash) {
    return;
  }

  await adjustLock(stash, STAKING_LOCK_ID, -amountOf(decoded), args.blockId);
};
