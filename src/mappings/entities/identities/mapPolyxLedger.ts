import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import {
  Account,
  AccountBalance,
  EntryDirection,
  EventIdEnum,
  HoldEntry,
  HoldReason,
  Identity,
  LockEntry,
  MovementKind,
  PolyxEntry,
  PolyxPool,
} from '../../../types';
import { bytesToString, getBigIntValue, getTextValue, padId } from '../../../utils';
import { camelToSnakeCase, is8xChain, snakeToCamelCase } from '../../../utils/common';
import { readStakingLock, resolveLegacyRewardDestination } from '../../../utils/staking';
import { ledgerAccount } from '../../../utils/accounts';
import { getEventParams } from '../../../utils/events';
import { extractArgs, HandlerArgs } from '../common';
import { getAccountId, systematicIssuers } from '../../consts';
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

/**
 * A `HoldReason` from a decoded `RuntimeHoldReason`'s **JSON** form.
 *
 * v8's `RuntimeHoldReason` is a *composite* enum — each pallet's own reason enum nested under that
 * pallet's name — so the staking hold is `Staking(pallet_staking::HoldReason::Staking)` and encodes
 * as `{ staking: 'Staking' }`, never as a bare string. Reading it with `toString()` (what
 * `getTextValue` does, via polkadot-js's `stringify(toJSON())`) yields `'{"staking":"Staking"}'`,
 * which matches no member — so every v8 hold decoded as `Unknown`, `bonded` was always 0 and
 * `otherReserved` always equalled `reserved`. The outer variant key is the reason; a runtime whose
 * reason is a plain unit enum encodes as the bare string instead.
 *
 * Takes JSON rather than a `Codec` so the same decode serves `balances.holds(who)` entries, whose
 * `id` arrives already-JSON from a storage read (see `reconcilePolyx`).
 */
export const holdReasonFromJson = (json: unknown): HoldReason => {
  let variant: string | undefined;

  if (typeof json === 'string') {
    variant = json;
  } else if (json && typeof json === 'object' && !Array.isArray(json)) {
    [variant] = Object.keys(json);
  }

  const key = variant?.toLowerCase();

  return (
    Object.values(HoldReason).find(member => member.toLowerCase() === key) ?? HoldReason.Unknown
  );
};

const holdReasonOf = (decoded: Record<string, Codec>): HoldReason | undefined => {
  const raw = optionalField(decoded, 'reason');

  return raw === undefined ? undefined : holdReasonFromJson(raw.toJSON());
};

const memoOf = (decoded: Record<string, Codec>): string | undefined => {
  const raw = optionalField(decoded, 'memo');

  return raw !== undefined ? bytesToString(raw) : undefined;
};

const startOfUtcDay = (datetime: Date): Date =>
  new Date(Date.UTC(datetime.getUTCFullYear(), datetime.getUTCMonth(), datetime.getUTCDate()));

const floorZero = (value: bigint): bigint => (value > BigInt(0) ? value : BigInt(0));

/** `Math.max` for `bigint`, which `Math.max` itself cannot take. */
const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);

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

  return maxBig(misc, fee);
};

// ---------------------------------------------------------------------------------------------
// Account / balance state
// ---------------------------------------------------------------------------------------------

export const emptyBalance = (
  address: string,
  identityId: string | undefined,
  blockEventId: string
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
    updatedEventId: blockEventId,
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
 * Frozen POLYX that a chain read could not attribute to a specific lock. Deliberately **not** the
 * staking lock: `bonded` is derived from that one, so filing an unattributed freeze there would
 * report it as a bond.
 */
export const RESIDUAL_LOCK_ID = 'residual';

/**
 * `balances.holds(who)` — the v8 per-reason breakdown of `reserved`.
 *
 * `undefined` on a runtime with no hold storage (pre-v8) or a failed read, which callers treat as
 * "no information", never as "no holds".
 */
export const readChainHolds = async (address: string): Promise<HoldEntry[] | undefined> => {
  try {
    const raw = (await api.query.balances.holds(address)).toJSON() as
      | { id?: unknown; amount?: string | number }[]
      | null;

    if (!Array.isArray(raw)) {
      return undefined;
    }

    return raw.map(entry => ({
      reason: holdReasonFromJson(entry.id),
      amount: BigInt(entry.amount ?? 0),
    }));
  } catch {
    return undefined;
  }
};

/**
 * An authoritative snapshot of everything that freezes an account's POLYX, read from chain.
 *
 * Captured by whoever does the chain read, rather than read inside `applyChainFreezes`, because
 * both callers need the read to happen against a specific block: the reconciler queues the
 * snapshot during the account's own block and corrects one block later (see `reconcilePolyx`), and
 * the seeder reads at its start block.
 */
export interface ChainFreezes {
  frozen: bigint;
  /** v8: `balances.holds(who)`. `undefined` pre-v8 or on a failed read. */
  holds?: HoldEntry[];
  /** pre-v8: `staking.ledger(controller).total`, the amount passed to `Currency::set_lock`. */
  stakingLock?: bigint;
}

/**
 * Rebuilds `locks` and `holds` from chain state, then recomputes the derived fields.
 *
 * Used wherever a derived balance is replaced wholesale by a chain read — the in-flight
 * reconciler's drift correction and the genesis / partial-index seed. Attribution matters because
 * `bonded` comes from the staking lock (pre-v8) or the `Staking` hold (v8): filing the whole
 * frozen amount under the staking lock calls every freeze a bond, and filing a pre-v8 staker's
 * freeze under a neutral id loses the bond entirely.
 *
 * - **v8:** bonds are holds, so `holds` is taken from `balances.holds` and `frozen` — a `Freezes`
 *   entry, unrelated to staking — goes under `RESIDUAL_LOCK_ID`. A `'staking '` lock must not be
 *   written on a v8 account at all: `handleBalanceUnlocked` reads one as an un-migrated pre-v8
 *   lock and clears it on the next `Unlocked`.
 * - **pre-v8:** the bond *is* a `'staking '` lock, pinned to `staking.ledger.total`; only the
 *   unexplained remainder goes under `RESIDUAL_LOCK_ID`.
 */
export const applyChainFreezes = (balance: AccountBalance, chain: ChainFreezes): void => {
  const { frozen, holds, stakingLock } = chain;
  const residual = (amount: bigint): LockEntry[] =>
    amount > BigInt(0) ? [{ lockId: RESIDUAL_LOCK_ID, amount }] : [];

  if (holds !== undefined) {
    balance.holds = holds;
    balance.locks = residual(frozen);
  } else {
    const staked = stakingLock ?? BigInt(0);

    balance.locks = [
      ...(staked > BigInt(0)
        ? [{ lockId: STAKING_LOCK_ID, amount: staked, reasons: 'staking' }]
        : []),
      ...residual(frozen > staked ? frozen : BigInt(0)),
    ];
  }

  recomputeDerived(balance);
};

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

  balance.frozen = locks.reduce((max, lock) => maxBig(max, lock.amount), BigInt(0));
  balance.bonded = maxBig(stakingHold, stakingLock);
  balance.otherReserved = floorZero(balance.reserved - stakingHold);
  balance.total = balance.free + balance.reserved;
  balance.transferable = floorZero(balance.free - balance.frozen);
};

/**
 * Folds one entry into `lifetimeByKind`. A negative `amountAbs` with `countDelta: -1` takes it back
 * out again, which is how `relabelEntry` moves an entry from one kind to another.
 */
const bumpLifetimeByKind = (
  balance: AccountBalance,
  kind: MovementKind,
  direction: EntryDirection,
  amountAbs: bigint,
  countDelta = 1
): void => {
  const totals = balance.lifetimeByKind ?? [];
  const signed = direction === EntryDirection.Credit ? amountAbs : -amountAbs;
  const entry = totals.find(total => total.kind === kind);

  if (entry) {
    entry.totalAbs += amountAbs;
    entry.net += signed;
    entry.count += countDelta;
  } else {
    totals.push({ kind, totalAbs: amountAbs, net: signed, count: countDelta });
  }

  balance.lifetimeByKind = totals.filter(total => total.count > 0);
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

interface MovementSide {
  endpoint: Endpoint;
  direction: EntryDirection;
  counterparty?: string;
}

/** The one or two account-sides a transition touches, each paired with its counterparty. */
const movementSides = (transition: Transition): MovementSide[] => {
  const sides: MovementSide[] = [];

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

  return sides;
};

/** The lifetime aggregate a movement kind feeds, if any. */
const LIFETIME_TOTAL: Partial<
  Record<MovementKind, 'totalFeesPaid' | 'totalRewards' | 'totalSlashed'>
> = {
  [MovementKind.Fee]: 'totalFeesPaid',
  [MovementKind.StakingReward]: 'totalRewards',
  [MovementKind.Slash]: 'totalSlashed',
};

/**
 * The direction an entry of that kind normally has. An entry pointing the other way is a reversal
 * of one — a refunded fee — and lowers the lifetime total instead of raising it.
 */
const LIFETIME_DIRECTION: Partial<Record<MovementKind, EntryDirection>> = {
  [MovementKind.Fee]: EntryDirection.Debit,
  [MovementKind.StakingReward]: EntryDirection.Credit,
  [MovementKind.Slash]: EntryDirection.Debit,
};

const rollupDelta = (kind: MovementKind, entry: Pick<PolyxEntry, 'direction' | 'amountAbs'>) =>
  entry.direction === LIFETIME_DIRECTION[kind] ? entry.amountAbs : -entry.amountAbs;

/** Advances the running `AccountBalance` for one side of a movement (pools + aggregates). */
const advanceBalance = (
  balance: AccountBalance,
  side: MovementSide,
  transition: Transition,
  signed: bigint,
  isInternal: boolean
): void => {
  if (side.endpoint.pool === PolyxPool.Free) {
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

  const lifetimeTotal = LIFETIME_TOTAL[transition.kind];
  if (lifetimeTotal) {
    balance[lifetimeTotal] += transition.amount;
  }

  bumpLifetimeByKind(balance, transition.kind, side.direction, transition.amount);
  balance.movementCount += 1;
  recomputeDerived(balance);
};

interface TransitionContext {
  args: HandlerArgs;
  transition: Transition;
  options: { eraIndex?: number };
  isInternal: boolean;
  date: Date;
  params: ReturnType<typeof getEventParams>;
}

/** Advances one account, writes its `PolyxEntry`, and reconciles it. */
const writeMovementSide = async (
  side: MovementSide,
  { args, transition, options, isInternal, date, params }: TransitionContext
): Promise<void> => {
  const { blockId, block, eventIdx, blockEventId } = args;
  const { address, pool } = side.endpoint;
  const signed = side.direction === EntryDirection.Credit ? transition.amount : -transition.amount;

  const account = await ledgerAccount(address, blockId, block.timestamp);
  const balance = await loadBalance(address, account.identityId, blockId);

  advanceBalance(balance, side, transition, signed, isInternal);
  balance.updatedEventId = blockEventId;
  await balance.save();

  const counterpartyAccount = side.counterparty ? await Account.get(side.counterparty) : undefined;

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
    blockId,
    extrinsicId: params.extrinsicId,
  }).save();

  await reconcileAccount(address, blockId, block, { eventIdx });
};

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

  const isInternal =
    transition.from?.address !== undefined && transition.from.address === transition.to?.address;

  const context: TransitionContext = {
    args,
    transition,
    options,
    isInternal,
    date: startOfUtcDay(args.block.timestamp),
    params: getEventParams(args),
  };

  for (const side of movementSides(transition)) {
    await writeMovementSide(side, context);
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
  blockEventId: string
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
  balance.updatedEventId = blockEventId;

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
  blockEventId: string,
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
  balance.updatedEventId = blockEventId;

  await balance.save();
};

/** Sets one lock on `address` to an absolute amount (0 clears it). */
export const setLock = async (
  address: string,
  lockId: string,
  amount: bigint,
  blockEventId: string,
  reasons?: string
): Promise<void> => {
  const balance = await AccountBalance.get(address);
  const current = balance?.locks?.find(lock => lock.lockId === lockId)?.amount ?? BigInt(0);

  await adjustLock(address, lockId, amount - current, blockEventId, reasons);
};

/**
 * Sets the pre-v8 `'staking '` lock on `stash` to `staking.ledger.total` read from chain.
 *
 * The chain read is authoritative — it already accounts for the max-bond cap, the rounding of a
 * compounded `Staked` reward, unbonding chunks, and slashes. When the ledger cannot be read the
 * `fallbackDelta` keeps the old accumulator behaviour so the reconciler still has a base to work
 * from.
 */
const syncStakingLock = async (
  stash: string,
  fallbackDelta: bigint,
  blockEventId: string
): Promise<void> => {
  const total = await readStakingLock(stash);

  if (total === undefined) {
    await adjustLock(stash, STAKING_LOCK_ID, fallbackDelta, blockEventId, 'staking');
    return;
  }

  await setLock(stash, STAKING_LOCK_ID, total, blockEventId, 'staking');
};

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
    const balance = await loadBalance(who, undefined, blockId);
    await balance.save();

    await adjustLock(who, lockId, sign * amountOf(decoded), blockEventId);
  };

/**
 * `balances.Locked` / `Unlocked` — the `LockableCurrency` floor on `free`.
 *
 * v8 adds one more source of `Unlocked`: the lock → hold storage migration. Polymesh holds a
 * pre-v8 bond as `Currency::set_lock("staking ", …)`, and v8 converts it to a `Staking` hold,
 * emitting per account — across two migration passes, in no extrinsic of the staker's own —
 * `balances.Upgraded`, the paired `balances.Held{Staking}` (which `handleBalanceHeld` already
 * turns into the `free → reserved` movement), and `balances.Unlocked{who, amount}` for the lock
 * removal. Only the lock side is left to do here. Post-v8 nothing re-creates a `'staking '`
 * `Currency` lock (new bonds are holds), so an account that still carries one on a v8 block has
 * an un-migrated pre-v8 lock and the `Unlocked` it sees is that migration removing it — clear the
 * `'staking '` lock rather than the generic `'balances'` one. Without this the pre-v8 staking lock
 * lingers and `frozen` over-reports for the ~420k blocks between the hold appearing (pass 1) and
 * the chain dropping the lock (pass 2).
 */
export const handleBalanceLocked = lockHandler('balances', BigInt(1));

const unlockGeneric = lockHandler('balances', BigInt(-1));

export const handleBalanceUnlocked = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);

  if (is8xChain(args.block)) {
    const who = holder(decodeEvent(event));
    const hasStakingLock =
      !!who &&
      ((await AccountBalance.get(who))?.locks ?? []).some(lock => lock.lockId === STAKING_LOCK_ID);

    if (who && hasStakingLock) {
      await setLock(who, STAKING_LOCK_ID, BigInt(0), args.blockEventId, 'staking');
      return;
    }
  }

  await unlockGeneric(event);
};

/** `balances.Frozen` / `Thawed` — the upstream `fungible` freeze, also a floor on `free`. */
export const handleBalanceFrozen = lockHandler('freeze', BigInt(1));
export const handleBalanceThawed = lockHandler('freeze', BigInt(-1));

// ---------------------------------------------------------------------------------------------
// Cross-event pairing helpers
// ---------------------------------------------------------------------------------------------

/**
 * Memos seen before their paired `Transfer`, keyed by extrinsic + endpoints + amount, per block.
 *
 * A **queue** per key, not one value: one `utility.batch` can make two transfers with the same
 * endpoints and the same amount but different memos, and a single slot let the second overwrite
 * the first (F11). Queued in emission order and consumed in the same order, which is the order the
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

  if (queued && queued.length === 0) {
    pendingMemos.delete(key);
  }

  return memo;
};

/**
 * Re-files an already-written entry under a different `kind`, moving every aggregate that was
 * bumped when it was first written.
 *
 * Several handlers correct an earlier entry's classification once a later event in the same
 * extrinsic or block explains it — a `balances` deposit that turns out to be a staking reward, a
 * transfer that turns out to be a treasury disbursement, a withdrawal that turns out to be the
 * transaction fee. Changing `kind` alone leaves `AccountBalance.lifetimeByKind` (and the
 * `totalFeesPaid` / `totalRewards` / `totalSlashed` rollups) still counting the entry under the
 * kind it no longer has — defect F12 — so both sides move together here.
 */
const relabelEntry = async (
  entry: PolyxEntry,
  kind: MovementKind,
  blockEventId: string,
  { eraIndex }: { eraIndex?: number } = {}
): Promise<void> => {
  const previous = entry.kind;

  if (previous !== kind) {
    const balance = await AccountBalance.get(entry.accountId);

    if (balance) {
      bumpLifetimeByKind(balance, previous, entry.direction, -entry.amountAbs, -1);
      bumpLifetimeByKind(balance, kind, entry.direction, entry.amountAbs);

      const from = LIFETIME_TOTAL[previous];
      const to = LIFETIME_TOTAL[kind];

      if (from) {
        balance[from] = floorZero(balance[from] - rollupDelta(previous, entry));
      }
      if (to) {
        balance[to] += rollupDelta(kind, entry);
      }

      balance.updatedEventId = blockEventId;
      await balance.save();
    }

    entry.kind = kind;
  }

  if (eraIndex !== undefined) {
    entry.eraIndex = eraIndex;
  }

  await entry.save();
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
  amountAbs?: bigint
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

  return amountAbs === undefined ? rows : rows.filter(row => row.amountAbs === amountAbs);
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
      ['blockId', '=', blockId],
      ['accountId', '=', account],
    ],
    { limit: 100 }
  );

  return rows.filter(row => kinds.includes(row.kind) && row.amountAbs === amountAbs);
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

  const [deposit] = args.extrinsicId
    ? await findExtrinsicEntries(args, MovementKind.Mint, who, amount)
    : await findBlockEntries(args.blockId, who, amount, [MovementKind.Mint]);

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
  const memo = memoOf(decoded) ?? takePendingMemo(args, from, to, amount);

  // F3: an endowment pairs with exactly one transfer. Without the `counterpartyAddress` guard a
  // batch making two equal transfers to the same new account matched the first endowment twice,
  // so the second transfer posted only its debit — the recipient's second credit was lost, and
  // the endowment's counterparty and memo were overwritten by the later one.
  const [endowment] = (await findExtrinsicEntries(args, MovementKind.Endowment, to, amount)).filter(
    entry => !entry.counterpartyAddress
  );

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
 *
 * **F11** — the memo belongs to the *movement*, so it is written to every entry sharing the
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

  const [unmemoed] = (await findExtrinsicEntries(args, MovementKind.Transfer, to, amount)).filter(
    entry => !entry.memo
  );

  if (unmemoed) {
    const sides = await PolyxEntry.getByFields([['movementId', '=', unmemoed.movementId]], {
      limit: 10,
    });

    for (const side of sides) {
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

  await postTransition(args, {
    from: { address: who, pool: PolyxPool.Free },
    to: { address: who, pool: PolyxPool.Reserved },
    amount,
    kind: MovementKind.Hold,
    holdReason: reason,
  });

  await adjustHold(who, reason, amount, args.blockEventId);
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

  await adjustHold(who, reason, -amount, args.blockEventId);
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
 * **F2** — the amount field is named `transferred` here, which the shared `amountOf` name list does
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

interface PoolDelta {
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

  const deltas = applyBalanceSet(balance, newFree, newReserved);

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
  balance.updatedEventId = blockEventId;
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
      createdEventId: blockEventId,
      blockId,
      extrinsicId: params.extrinsicId,
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

const treasuryPalletAccount = (): string =>
  getAccountId(systematicIssuers.treasury.accountId, api.registry.chainSS58);

export const handleTreasuryDisbursement = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const [, rawToDid, rawTo, rawBalance] = args.params;

  // `TreasuryDisbursement(authorizingDid, targetDid, targetAccount?, amount)`. The first param is
  // the committee that authorised the spend, **not** the source of funds — `treasury.disbursement`
  // always moves POLYX out of the treasury pallet account (the mirror of the reimbursement
  // handler's credit). Debiting `authorizingDid`'s primary key instead left the treasury drifting
  // high forever and the committee account low (defect: the block-352,843 disbursements).
  //
  // (IdentityId, IdentityId, AccountId, Balance) from 5.0.0; (IdentityId, IdentityId, Balance) before
  const hasToAddress = args.params.length >= 4;
  const amount = getBigIntValue(hasToAddress ? rawBalance : rawTo);
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
    // From 5.0.0 `treasury.disbursement` also emits `balances.Transfer{treasury → recipient}`;
    // relabel both sides of it rather than writing a second movement.
    const siblings = await PolyxEntry.getByFields(
      [['movementId', '=', existingTransfer.movementId]],
      { limit: 10 }
    );

    for (const sibling of siblings) {
      await relabelEntry(sibling, MovementKind.TreasuryDisbursement, args.blockEventId);
    }

    return;
  }

  await postTransition(args, {
    from: { address: treasuryPalletAccount(), pool: PolyxPool.Free },
    to: toAddress ? { address: toAddress, pool: PolyxPool.Free } : undefined,
    amount,
    kind: MovementKind.TreasuryDisbursement,
  });
};

export const handleTreasuryReimbursement = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const [, rawBalance] = args.params;

  // `TreasuryReimbursement(payerDid, amount)` — the amount routed to the treasury out of a fee.
  // The payer's full fee is already debited by `protocolFee.FeeCharged` /
  // `transactionPayment.TransactionFeePaid`, so this is the treasury's credit, not a refund to
  // the payer. (The pre-5.4.1 author split is not emitted and stays outside the ledger.)
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
 * **F9** — on v8 the fee is *already* a balance movement by the time this fires. The runtime pays
 * fees through `FungibleAdapter<Balances, DealWithFees>`, so the chain emits
 * `balances.Withdraw{who, estimated}` (indexed as a `Burn`) first, then — when the estimate was
 * high — `balances.Deposit{who, estimated − actual}` refunding the payer (a `Mint`), and finally
 * this event. Posting a debit here as well charged every fee-paying account twice, drifting `free`
 * low by its lifetime fees, and `protocolFee.FeeCharged` (whose `withdraw_fee` also emits
 * `Withdraw`) behaved the same way.
 *
 * So the withdrawal is re-filed as the fee rather than a second debit being posted, and a refund
 * becomes the fee's credit side, leaving the pair netting to the fee actually charged. Matching is
 * by extrinsic and the account the *events* name — a subsidised fee is withdrawn from the
 * subsidiser, not the signer. A runtime that charges a fee with no paired `balances` event (every
 * pre-v8 Polymesh runtime, which used its own balances implementation) finds nothing to re-file
 * and posts the debit here, exactly as before.
 */
export const handleTransactionFeeCharged = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const [rawWho, rawAmount] = args.params;

  const who = getTextValue(rawWho);
  const fee = getBigIntValue(rawAmount);

  // The withdrawal covers the fee, so it is the exact match or the smallest larger burn — larger
  // when part of it is about to be refunded. Anything smaller belongs to a different charge.
  const burns = await findExtrinsicEntries(args, MovementKind.Burn, who);
  const withdrawal =
    burns.find(row => row.amountAbs === fee) ??
    burns
      .filter(row => row.amountAbs > fee)
      .sort((a, b) => (a.amountAbs < b.amountAbs ? -1 : 1))[0];

  if (withdrawal) {
    await relabelEntry(withdrawal, MovementKind.Fee, args.blockEventId);

    const refunded = withdrawal.amountAbs - fee;

    if (refunded > BigInt(0)) {
      const [refund] = await findExtrinsicEntries(args, MovementKind.Mint, who, refunded);

      if (refund) {
        await relabelEntry(refund, MovementKind.Fee, args.blockEventId);
      }
    }

    return;
  }

  await postTransition(args, {
    from: { address: who, pool: PolyxPool.Free },
    amount: fee,
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

/**
 * Exported so `mapStakingEvent.ts` can stamp the same era onto `StakingEvent` rows that
 * `PolyxEntry` already gets stamped with — one cache, one answer to "what era is this block's
 * payout for," rather than two that could disagree.
 */
export const currentPayoutEra = (blockId: string): number | undefined =>
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
): Promise<{ recipient: string; restaked: boolean } | undefined> => {
  if (!stash) {
    return undefined;
  }

  if (is8x) {
    // v8: `dest: Staked` restakes via the paired `balances.Held{Staking}`, so no lock work here.
    const dest = optionalField(decoded, 'dest');
    const json = dest?.toJSON() as string | Record<string, unknown> | undefined;

    if (json && typeof json === 'object') {
      return {
        recipient: ((json.account ?? json.Account) as string | undefined) ?? stash,
        restaked: false,
      };
    }

    return { recipient: stash, restaked: false };
  }

  const { rewardDestination, rewardDestinationAccount } = await resolveLegacyRewardDestination(
    stash
  );

  // Pre-v8 `Staked` auto-restakes: the reward lands in `free` and is immediately locked, and no
  // `staking.Bonded` is emitted for it — so the lock has to be raised here.
  return {
    recipient: rewardDestinationAccount ?? stash,
    restaked: rewardDestination === 'Staked',
  };
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
  const resolved = await rewardRecipient(decoded, stash, is8xChain(args.block));

  if (!resolved) {
    return;
  }

  const { recipient, restaked } = resolved;

  // If a `balances` deposit for this reward was already recorded as a plain mint, relabel it.
  const mints = await findBlockEntries(args.blockId, recipient, amount, [MovementKind.Mint]);

  if (mints.length > 0) {
    for (const mint of mints) {
      await relabelEntry(mint, MovementKind.StakingReward, args.blockEventId, { eraIndex });
    }
  } else {
    await postTransition(
      args,
      {
        to: { address: recipient, pool: PolyxPool.Free },
        amount,
        kind: MovementKind.StakingReward,
      },
      { eraIndex }
    );
  }

  // Pre-v8 `Staked` payee: the reward is added to the staking lock in the same step.
  if (restaked) {
    await syncStakingLock(recipient, amount, args.blockEventId);
  }
};

/**
 * `staking.Slash` / `Slashed` — a real movement at both eras, but out of a different pool.
 *
 * **F10** — on v8 a staking slash is taken from the *held* balance, not from free:
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
    await syncStakingLock(stash, -amount, args.blockEventId);
  }
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
  await syncStakingLock(stash, amountOf(decoded), args.blockEventId);
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

  await syncStakingLock(stash, -amountOf(decoded), args.blockEventId);
};
