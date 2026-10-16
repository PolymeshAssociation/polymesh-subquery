import { Codec } from '@polkadot/types/types';
import { compactFromU8a, hexHasPrefix, u8aToBn } from '@polkadot/util';
import { SubstrateBlock } from '@subql/types';
import { namedFields, optionalField } from '../../../decode';
import { isObject, optionalMemberOf, optionOf } from '../../../utils/codec';
import { findStorage } from '../../../utils/legacyQuery';
import { blockEvents, substrateEventAt } from '../../../utils/blockEvents';
import {
  Account,
  AccountBalance,
  EntryDirection,
  HoldReason,
  MovementKind,
  PolyxEntry,
  PolyxPool,
} from '../../../types';
import { getBigIntValue, getTextValue, padId } from '../../../utils';
import { hexToString } from '../../../utils/common';
import { ledgerAccount } from '../../../utils/accounts';
import { getEventParams } from '../../../utils/events';
import { readStorage } from '../../../utils/storageAtParent';
import { HandlerArgs } from '../common';
import { extrinsicEventIndices, getLedgerEntries } from '../../blockContext';
import { memoText } from '../../../utils/text';
import { codecBytes } from '../../../utils/bytes';

/**
 * The POLYX ledger's model, shared by every era's handlers: the running `AccountBalance`, the
 * `PolyxEntry` each movement writes through `postTransition`, locks and holds, and the lookups
 * that pair one event with the entries an earlier event in the block wrote.
 *
 * The handlers are in `mapPolyxLedger.ts`, and what only applies before v8 in `preV8Ledger.ts`.
 */

// ---------------------------------------------------------------------------------------------
// Decoded-field helpers
// ---------------------------------------------------------------------------------------------

export const firstText = (decoded: Record<string, Codec>, names: string[]): string | undefined => {
  for (const name of names) {
    const value = optionalField(decoded, name);

    if (value !== undefined) {
      return getTextValue(value);
    }
  }

  return undefined;
};

export const holder = (decoded: Record<string, Codec>): string | undefined =>
  firstText(decoded, ['who', 'account', 'stash']);

export const amountOf = (decoded: Record<string, Codec>): bigint => {
  for (const name of ['amount', 'balance', 'freeBalance', 'free', 'value', 'actualFee']) {
    const value = optionalField(decoded, name);

    if (value !== undefined) {
      return getBigIntValue(value);
    }
  }

  return BigInt(0);
};

/**
 * A `HoldReason` from a decoded `RuntimeHoldReason`'s **JSON** form, plus the pallet's own reason
 * variant nested under it when that is a plain unit variant (`Revive(StorageDepositReserve)`
 * encodes as `{ revive: 'StorageDepositReserve' }`). A bare-string reason has no variant.
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
 * `id` arrives already-JSON from a storage read (see `readChainHolds`).
 */
export const holdReasonVariantOf = (json: unknown): { reason: HoldReason; variant?: string } => {
  let outer: string | undefined;
  let variant: string | undefined;

  if (typeof json === 'string') {
    outer = json;
  } else if (json && typeof json === 'object' && !Array.isArray(json)) {
    [outer] = Object.keys(json);
    const inner = (json as Record<string, unknown>)[outer];

    variant = typeof inner === 'string' ? inner : undefined;
  }

  const key = outer?.toLowerCase();

  return {
    reason:
      Object.values(HoldReason).find(member => member.toLowerCase() === key) ?? HoldReason.Unknown,
    variant,
  };
};

/** Just the outer `HoldReason` of `holdReasonVariantOf`. */
export const holdReasonFromJson = (json: unknown): HoldReason => holdReasonVariantOf(json).reason;

export const holdReasonOf = (decoded: Record<string, Codec>): HoldReason | undefined => {
  const raw = optionalField(decoded, 'reason');

  return raw === undefined ? undefined : holdReasonFromJson(raw.toJSON());
};

export const memoOf = (decoded: Record<string, Codec>): string | undefined => {
  const raw = optionalField(decoded, 'memo');

  return raw !== undefined ? memoText(raw) : undefined;
};

export const startOfUtcDay = (datetime: Date): Date =>
  new Date(Date.UTC(datetime.getUTCFullYear(), datetime.getUTCMonth(), datetime.getUTCDate()));

export const floorZero = (value: bigint): bigint => (value > BigInt(0) ? value : BigInt(0));

/** `Math.max` for `bigint`, which `Math.max` itself cannot take. */
const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/**
 * A lock, hold or kind total with its amounts as `bigint`s, as the ledger computes with them. The
 * JSON columns (`LockEntry`, `HoldEntry`, `KindTotal`) keep amounts as decimal strings, because
 * SubQuery writes a `bigint` inside JSON as `"<digits>n"`, which consumers would then receive.
 */
export interface Lock {
  lockId: string;
  amount: bigint;
  reasons?: string;
}

export interface Hold {
  reason: string;
  amount: bigint;
}

interface KindTotalValue {
  kind: string;
  totalAbs: bigint;
  net: bigint;
  count: number;
}

export const locksOf = (balance: AccountBalance): Lock[] =>
  (balance.locks ?? []).map(lock => ({ ...lock, amount: BigInt(lock.amount) }));

const setLocks = (balance: AccountBalance, locks: Lock[]): void => {
  balance.locks = locks.map(lock => ({ ...lock, amount: lock.amount.toString() }));
};

export const holdsOf = (balance: AccountBalance): Hold[] =>
  (balance.holds ?? []).map(hold => ({ ...hold, amount: BigInt(hold.amount) }));

const setHolds = (balance: AccountBalance, holds: Hold[]): void => {
  balance.holds = holds.map(hold => ({ ...hold, amount: hold.amount.toString() }));
};

const kindTotalsOf = (balance: AccountBalance): KindTotalValue[] =>
  (balance.lifetimeByKind ?? []).map(total => ({
    ...total,
    totalAbs: BigInt(total.totalAbs),
    net: BigInt(total.net),
  }));

const setKindTotals = (balance: AccountBalance, totals: KindTotalValue[]): void => {
  balance.lifetimeByKind = totals.map(total => ({
    ...total,
    totalAbs: total.totalAbs.toString(),
    net: total.net.toString(),
  }));
};

/**
 * `frozen` from an on-chain `AccountData`: `{ free, reserved, frozen, flags }` on v8,
 * `{ free, reserved, miscFrozen, feeFrozen }` (frozen is the max of the two) on ≤ v7.4.
 */
export const accountDataFrozen = (data: unknown): bigint => {
  if (!isObject(data)) {
    throw new TypeError(`AccountData was expected, but the value is ${typeof data}`);
  }

  // an absent half reads as zero, as the fixed-point reads of an absent amount always have
  const frozen = optionalMemberOf(data, 'frozen');

  if (frozen !== undefined) {
    return getBigIntValue(frozen);
  }

  const amount = (key: string): bigint => {
    const raw = optionalMemberOf(data, key);

    return raw === undefined ? BigInt(0) : getBigIntValue(raw);
  };
  const misc = amount('miscFrozen');
  const fee = amount('feeFrozen');

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

/**
 * The balance row for an address, created empty when the ledger has not seen it before.
 *
 * Every balance mutation goes through here.
 */
export const loadBalance = async (
  address: string,
  identityId: string | undefined,
  blockEventId: string
): Promise<AccountBalance> => {
  const existing = await AccountBalance.get(address);

  if (existing) {
    if (!existing.identityId && identityId) {
      existing.identityId = identityId;
    }

    return existing;
  }

  return emptyBalance(address, identityId, blockEventId);
};

/** Pre-v8 staking bonds via a lock with this identifier; v8 bonds via a `Staking` hold. */
export const STAKING_LOCK_ID = 'staking ';

/**
 * Frozen POLYX that a chain read could not attribute to a specific lock. Deliberately **not** the
 * staking lock: `bonded` is derived from that one, so filing an unattributed freeze there would
 * report it as a bond.
 */
export const RESIDUAL_LOCK_ID = 'residual';

/** The pips pallet's `LockIdentifier` for proposal and vote deposits (`*b"pips    "`). */
export const PIPS_LOCK_ID = 'pips    ';

/**
 * `balances.holds(who)` — the v8 per-reason breakdown of `reserved`.
 *
 * `undefined` on a runtime with no hold storage (pre-v8), which callers treat as "no information",
 * never as "no holds". Throws `UndecodableStateError` when the list doesn't decode with the block's
 * metadata, as for an account that still holds for a removed pallet.
 */
export const readChainHolds = async (address: string): Promise<Hold[] | undefined> => {
  if (typeof api.query.balances?.holds !== 'function') {
    return undefined;
  }

  const raw = await readStorage(
    `balances.holds of ${address}`,
    async () =>
      (await api.query.balances.holds(address)).toJSON() as
        | { id?: unknown; amount?: string | number }[]
        | null
  );

  if (!Array.isArray(raw)) {
    return undefined;
  }

  return raw.map(entry => ({
    reason: holdReasonFromJson(entry.id),
    amount: BigInt(entry.amount ?? 0),
  }));
};

/**
 * The amount of the lock `lockId` on chain for `address`, from `balances.locks(who)` — `0` once
 * there is none, `undefined` when the locks are not a list. Both eras keep `balances.locks`. Throws
 * `UndecodableStateError` when the locks don't decode with the block's metadata.
 */
export const readChainLock = async (
  address: string,
  lockId: string
): Promise<bigint | undefined> => {
  const raw = await readStorage(
    `balances.locks of ${address}`,
    async () =>
      (await api.query.balances.locks(address)).toJSON() as
        | { id?: string; amount?: string | number }[]
        | null
  );

  if (!Array.isArray(raw)) {
    return undefined;
  }

  const lock = raw.find(entry => {
    const id = entry.id ?? '';
    return (hexHasPrefix(id) ? hexToString(id) : id) === lockId;
  });

  return lock ? BigInt(lock.amount ?? 0) : BigInt(0);
};

/**
 * The `'staking '` lock still listed on chain for `address` — `0` once there is none, `undefined`
 * when the locks are not a list. Throws `UndecodableStateError` when they don't decode (see
 * `readChainLock`).
 *
 * On v8 the lock → hold migration first holds the stake and leaves the lock listed, then removes
 * it. Whether a listed lock still freezes anything is `frozen` (see `readChainFrozen`).
 */
export const readChainStakingLock = (address: string): Promise<bigint | undefined> =>
  readChainLock(address, STAKING_LOCK_ID);

/**
 * `frozen` from `system.account(address)`, the amount the chain freezes. Throws
 * `UndecodableStateError` when the account doesn't decode with the block's metadata.
 */
export const readChainFrozen = async (address: string): Promise<bigint> => {
  const { data } = await readStorage(`system.account of ${address}`, () =>
    api.query.system.account(address)
  );

  return accountDataFrozen(data);
};

/**
 * An authoritative snapshot of everything that freezes an account's POLYX, read from chain.
 *
 * Captured by whoever does the chain read, rather than read inside `applyChainFreezes`, because the
 * read has to happen against a specific block: the seeder reads at its start block.
 */
export interface ChainFreezes {
  frozen: bigint;
  /** v8: `balances.holds(who)`. `undefined` pre-v8 or on a failed read. */
  holds?: Hold[];
  /**
   * The amount of the `'staking '` lock on chain. Pre-v8 that is `staking.ledger.total` — the
   * value passed to `Currency::set_lock` — and on v8 it is read from `balances.locks`, since it
   * only survives there until the second migration pass drops it.
   */
  stakingLock?: bigint;
  /**
   * Pre-v8: the `'pips    '` lock from `balances.locks`. Left unset on v8, where pips deposits
   * reach the ledger through `balances.Locked`/`Unlocked` under the generic id instead.
   */
  pipsLock?: bigint;
}

/**
 * Rebuilds `locks` and `holds` from chain state, then recomputes the derived fields.
 *
 * Used where a derived balance is replaced wholesale by a chain read — the genesis / partial-index
 * seed. Attribution matters because
 * `bonded` comes from the staking lock (pre-v8) or the `Staking` hold (v8): filing the whole
 * frozen amount under the staking lock calls every freeze a bond, and filing a pre-v8 staker's
 * freeze under a neutral id loses the bond entirely.
 *
 * - **v8:** bonds are holds, so `holds` is taken from `balances.holds`.
 * - **both eras:** whatever part of `frozen` is still a `'staking '` lock on chain keeps that id,
 *   and only the unexplained remainder goes under `RESIDUAL_LOCK_ID`.
 * - **pre-v8:** a PIPs deposit lock keeps its `'pips    '` id too, so the refund that clears it
 *   (see `handleProposalRefund`) is not left behind by a residual copy of the same amount.
 *
 * The lock rule is the same on v8 because of the two-pass lock → hold migration: between the
 * passes a v8 staker carries both the new `Staking` hold *and* its old `'staking '` lock. Filing
 * that lock as residual broke the second pass, whose `Unlocked` is recognised by the lock's id —
 * the lock was never cleared, and a testnet resync caught ten accounts reporting `frozen` of up to
 * 4.96M POLYX against a chain value of 0.
 *
 * A lock can never exceed what is frozen, so each is capped there. Locks overlap rather than add
 * (`frozen` is their MAX), so the residual is only what exceeds the largest attributed lock.
 *
 * **An empty `holds` on v8 is written as-is, even though it can mean "not migrated yet".** v8
 * converts locks to holds lazily, so an account the migration has not reached reads `[]` from
 * `balances.holds` while it is still bonded. That is safe only because of the order the migration
 * works in — the hold is added before the lock is removed, so an account is never without both —
 * and because `bonded` is the MAX of the staking hold and the staking lock: until the account
 * migrates, its lock carries the bond. Treating `[]` as "unknown" and keeping the derived holds
 * instead would be worse, since those were derived before the chain was consulted at all. Anything
 * that changes how `bonded` is derived has to keep this case, which the seeder's reserved-nothing
 * test pins.
 */
export const applyChainFreezes = (balance: AccountBalance, chain: ChainFreezes): void => {
  const { frozen, holds, stakingLock, pipsLock } = chain;

  if (holds !== undefined) {
    setHolds(balance, holds);
  }

  const capped = (amount?: bigint): bigint => {
    const value = amount ?? BigInt(0);
    return value < frozen ? value : frozen;
  };
  const stakingPart = capped(stakingLock);
  const pipsPart = capped(pipsLock);
  const explained = stakingPart > pipsPart ? stakingPart : pipsPart;

  setLocks(balance, [
    ...(stakingPart > BigInt(0)
      ? [{ lockId: STAKING_LOCK_ID, amount: stakingPart, reasons: 'staking' }]
      : []),
    ...(pipsPart > BigInt(0) ? [{ lockId: PIPS_LOCK_ID, amount: pipsPart, reasons: 'pips' }] : []),
    ...(frozen > explained ? [{ lockId: RESIDUAL_LOCK_ID, amount: frozen }] : []),
  ]);

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
  const locks = locksOf(balance);
  const holds = holdsOf(balance);

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
export const bumpLifetimeByKind = (
  balance: AccountBalance,
  kind: MovementKind,
  direction: EntryDirection,
  amountAbs: bigint,
  countDelta = 1
): void => {
  const totals = kindTotalsOf(balance);
  const signed = direction === EntryDirection.Credit ? amountAbs : -amountAbs;
  const entry = totals.find(total => total.kind === kind);

  if (entry) {
    entry.totalAbs += amountAbs;
    entry.net += signed;
    entry.count += countDelta;
  } else {
    totals.push({ kind, totalAbs: amountAbs, net: signed, count: countDelta });
  }

  setKindTotals(
    balance,
    totals.filter(total => total.count > 0)
  );
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
  /** who the value came from, for a credit with no debit side here (a slash's reporter reward) */
  source?: string;
  /** who the value went to, for a debit with no credit side here (a reserve funding a credit) */
  destination?: string;
}

export const poolTag = (pool: PolyxPool): string => (pool === PolyxPool.Free ? 'f' : 'r');

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
      counterparty: transition.to?.address ?? transition.destination,
    });
  }

  if (transition.to?.address) {
    sides.push({
      endpoint: transition.to,
      direction: EntryDirection.Credit,
      counterparty: transition.from?.address ?? transition.source,
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

  // Only on the side the total is about: a reward paid from the block reward reserve has a debit
  // side too, and the reserve received no reward.
  const lifetimeTotal = LIFETIME_TOTAL[transition.kind];
  const lifetimeSide = LIFETIME_DIRECTION[transition.kind];
  if (lifetimeTotal && (lifetimeSide === undefined || lifetimeSide === side.direction)) {
    balance[lifetimeTotal] += transition.amount;
  }

  bumpLifetimeByKind(balance, transition.kind, side.direction, transition.amount);
  balance.movementCount += 1;
  recomputeDerived(balance);
};

/**
 * `idTag` keeps apart the entries of two movements filed under one event, which would otherwise
 * share ids: an entry's id is its event and pool and direction, and carries no account.
 */
export interface TransitionOptions {
  eraIndex?: number;
  idTag?: string;
}

interface TransitionContext {
  args: HandlerArgs;
  transition: Transition;
  options: TransitionOptions;
  isInternal: boolean;
  date: Date;
  params: ReturnType<typeof getEventParams>;
}

/** Advances one account and writes its `PolyxEntry`. */
const writeMovementSide = async (
  side: MovementSide,
  { args, transition, options, isInternal, date, params }: TransitionContext
): Promise<void> => {
  const { blockId, block, eventIdx, blockEventId } = args;
  const { address, pool } = side.endpoint;
  const signed = side.direction === EntryDirection.Credit ? transition.amount : -transition.amount;

  const account = await ledgerAccount(address, blockId, block.timestamp);
  const balance = await loadBalance(address, account.identityId, blockEventId);

  advanceBalance(balance, side, transition, signed, isInternal);
  balance.updatedEventId = blockEventId;
  await balance.save();

  const counterpartyAccount = side.counterparty ? await Account.get(side.counterparty) : undefined;

  const entry = PolyxEntry.create({
    id: `${blockId}/${padId(eventIdx.toString())}/${poolTag(pool)}${
      side.direction === EntryDirection.Debit ? 'd' : 'c'
    }${options.idTag ?? ''}`,
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
  });
  await entry.save();
  getLedgerEntries(blockId).add(entry);
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
  options: TransitionOptions = {}
): Promise<void> => {
  // A movement of nothing writes nothing. Left in, a `Withdraw` of 0 ahead of a v8 Ethereum
  // transaction's fee was taken for the fee's own withdrawal, being the payer's first burn, so the
  // fee was charged twice (testnet block 25,118,132), and every empty event wrote an entry and a
  // balance version for no change.
  if ((!transition.from && !transition.to) || transition.amount === BigInt(0)) {
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

  // One after the other: a move between an account's own pools has both sides on one balance.
  const [first, second] = movementSides(transition);

  if (first) {
    await writeMovementSide(first, context);
  }
  if (second) {
    await writeMovementSide(second, context);
  }
};

/**
 * v8-only hold tracking. `Held`/`Released`/`BurnedHeld` move the balance through `postTransition`;
 * this keeps the per-reason breakdown in `AccountBalance.holds` so `bonded`/`otherReserved` stay
 * derivable without a scan. On a v8 chain `SUM(holds) == reserved`.
 */
/** A hold entry's bytes: the pallet's index, its fieldless `HoldReason`, and a `u128` amount */
const RAW_HOLD_BYTES = 1 + 1 + 16;

/**
 * `balances.holds(who)` at the end of `block`, from its raw bytes: a compact count, then per entry
 * the pallet's index, its fieldless `HoldReason` and a `u128`, each pallet named from the block's
 * metadata. `undefined` when the runtime has no holds, or the bytes don't fit that layout.
 */
const rawChainHolds = async (
  address: string,
  block: SubstrateBlock
): Promise<Hold[] | undefined> => {
  const item = findStorage('balances', 'holds');

  if (!item) {
    return undefined;
  }

  const stored = optionOf(
    await api.rpc.state.getStorage(item.key(address), block.block.header.hash.toHex()),
    `balances.holds of ${address}`
  );

  if (!stored) {
    return [];
  }

  const bytes = codecBytes(stored);
  const [offset, length] = compactFromU8a(bytes);
  const count = length.toNumber();

  if (bytes.length !== offset + count * RAW_HOLD_BYTES) {
    return undefined;
  }

  const pallets = new Map(
    api.registry.metadata.pallets.map(pallet => [pallet.index.toNumber(), pallet.name.toString()])
  );
  const byReason = new Map<HoldReason, bigint>();

  for (let index = 0; index < count; index += 1) {
    const start = offset + index * RAW_HOLD_BYTES;
    const reason = holdReasonFromJson(pallets.get(bytes[start]));
    const amount = BigInt(u8aToBn(bytes.subarray(start + 2, start + RAW_HOLD_BYTES)).toString());
    byReason.set(reason, (byReason.get(reason) ?? BigInt(0)) + amount);
  }

  return [...byReason].map(([reason, amount]) => ({ reason, amount }));
};

/**
 * The events that end in `adjustHold`, and the fields naming the account each one adjusts. A
 * transfer-and-hold only adjusts its destination, which it gains a hold on; its source is moved
 * by no hold. A transfer-on-hold is the reverse: the source's hold shrinks and the destination's
 * free balance grows.
 */
const HOLD_EVENT_ACCOUNTS: Record<string, string[][]> = {
  'balances.Held': [['who', 'account', 'stash']],
  'balances.Released': [['who', 'account', 'stash']],
  'balances.BurnedHeld': [['who', 'account', 'stash']],
  'balances.TransferOnHold': [['source', 'from']],
  'balances.TransferAndHold': [['dest', 'to']],
  'staking.Slashed': [['staker', 'stash', 'who', 'account']],
};

/**
 * Whether an event after index `eventIdx` in `block` adjusts a hold of `address`.
 *
 * A later event is only looked at, not handled, so one that does not decode is left to its own
 * handler to record. Every event here is struct-style, which names its fields without the shape
 * table. A transfer-and-hold adjusts a hold only when its reason resolves, so one that names none
 * does not count: nothing would take the chain's list after it.
 *
 * A currency migration is not among them: it sets the hold from the ledger rather than by a delta,
 * and usually follows the `Held` that stakes the migrated balance without withdrawing anything, so
 * deferring to it would leave the hold list untouched.
 */
const holdChangesLater = (block: SubstrateBlock, eventIdx: number, address: string): boolean =>
  blockEvents(block).some((record, idx) => {
    if (idx <= eventIdx) {
      return false;
    }

    const accounts =
      HOLD_EVENT_ACCOUNTS[`${record.event.section.toLowerCase()}.${record.event.method}`];

    if (!accounts) {
      return false;
    }

    try {
      const decoded = namedFields(substrateEventAt(block, idx));

      if (!decoded) {
        return false;
      }

      const transfer =
        record.event.method === 'TransferOnHold' || record.event.method === 'TransferAndHold';

      return (
        (!transfer || holdReasonOf(decoded) !== undefined) &&
        accounts.some(names => firstText(decoded, names) === address)
      );
    } catch {
      return false;
    }
  });

/**
 * Adjusts one hold on `address` by `delta`, by reason.
 *
 * Given the block and the event's index, an account that still holds for a pallet the runtime no
 * longer has (testnet's `contracts` holds, filed as `Unknown`) takes its holds from the chain
 * instead. The runtime can't decode such a list, so it treats it as empty: the next hold it places
 * replaces the whole list, and its `Held` reports the new total as if nothing was held before
 * (testnet 25,042,637). The reserved balance still moves as the events say; only the breakdown is
 * the chain's.
 *
 * The chain's list is the state after the whole block, so it is only taken at the account's last
 * hold change in the block. At an earlier one the delta applies as usual and the `Unknown` entry
 * stays, or the later event would add its hold on top of a list that already has it.
 */
export const adjustHold = async (
  address: string,
  reason: HoldReason,
  delta: bigint,
  blockEventId: string,
  block?: SubstrateBlock,
  eventIdx?: number
): Promise<void> => {
  const balance = await AccountBalance.get(address);

  if (!balance) {
    return;
  }

  let holds = holdsOf(balance);
  const entry = holds.find(hold => hold.reason === reason);

  if (entry) {
    entry.amount = floorZero(entry.amount + delta);
  } else if (delta > BigInt(0)) {
    holds.push({ reason, amount: delta });
  }

  if (
    block &&
    eventIdx !== undefined &&
    holds.some(hold => hold.reason === HoldReason.Unknown) &&
    !holdChangesLater(block, eventIdx, address)
  ) {
    holds = (await rawChainHolds(address, block)) ?? holds;
  }

  setHolds(
    balance,
    holds.filter(hold => hold.amount > BigInt(0))
  );
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
 * Pre-v8 PIPs deposit locks have no lock event; `syncPipsLock` reads them back from chain.
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

  const locks = locksOf(balance);
  const entry = locks.find(lock => lock.lockId === lockId);

  if (entry) {
    entry.amount = floorZero(entry.amount + delta);
    if (reasons !== undefined) {
      entry.reasons = reasons;
    }
  } else if (delta > BigInt(0)) {
    locks.push({ lockId, amount: delta, reasons });
  }

  setLocks(
    balance,
    locks.filter(lock => lock.amount > BigInt(0))
  );
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
  const current = balance
    ? locksOf(balance).find(lock => lock.lockId === lockId)?.amount ?? BigInt(0)
    : BigInt(0);

  await adjustLock(address, lockId, amount - current, blockEventId, reasons);
};

// ---------------------------------------------------------------------------------------------
// Cross-event pairing helpers
// ---------------------------------------------------------------------------------------------

/**
 * Re-files an already-written entry under a different `kind`, moving every aggregate that was
 * bumped when it was first written.
 *
 * Several handlers correct an earlier entry's classification once a later event in the same
 * extrinsic or block explains it — a `balances` deposit that turns out to be a staking reward, a
 * transfer that turns out to be a treasury disbursement, a withdrawal that turns out to be the
 * transaction fee. Changing `kind` alone leaves `AccountBalance.lifetimeByKind` (and the
 * `totalFeesPaid` / `totalRewards` / `totalSlashed` rollups) still counting the entry under the
 * kind it no longer has — so both sides move together here.
 */
export const relabelEntry = async (
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
 * Entries already written in this extrinsic for `(kind, account)`, narrowed to `amountAbs` if given.
 * The live objects, from the block's own index (see `LedgerEntries`).
 */
export const findExtrinsicEntries = (
  args: HandlerArgs,
  kind: MovementKind,
  account: string | undefined,
  amountAbs?: bigint
): PolyxEntry[] => {
  if (!args.extrinsicId || !account) {
    return [];
  }

  return getLedgerEntries(args.blockId)
    .inExtrinsic(args.extrinsicId)
    .filter(
      row =>
        row.kind === kind &&
        row.accountId === account &&
        (amountAbs === undefined || row.amountAbs === amountAbs)
    );
};

/**
 * The entry among `candidates` written closest *before* the current event — the one a paired event
 * refers to when several match on account and amount. Block-scoped ids are zero-padded, so
 * `movementId` order is event order.
 */
export const nearestPreceding = (
  candidates: PolyxEntry[],
  args: HandlerArgs
): PolyxEntry | undefined =>
  candidates
    .filter(entry => entry.movementId < args.blockEventId)
    .sort((a, b) => (a.movementId < b.movementId ? 1 : -1))[0];

/** The `movementId`s of the two events before the current one in this block. */
export const recentEventIds = (args: HandlerArgs): Set<string> =>
  new Set([1, 2].map(back => `${args.blockId}/${padId(String(args.eventIdx - back))}`));

/** The `movementId` of the event immediately before the current one in this block. */
export const previousEventId = (args: HandlerArgs): string =>
  `${args.blockId}/${padId(String(args.eventIdx - 1))}`;

/**
 * Entries written earlier in this block for `account` of one of `kinds`, narrowed to `amountAbs`.
 *
 * Staking rewards arrive from `on_initialize`, not an extrinsic, so the reward event and any
 * paired `balances` deposit can only be matched on the block. Used to keep a v8 reward from being
 * counted twice — once as `Mint`, once as `StakingReward`.
 */
export const findBlockEntries = (
  blockId: string,
  account: string | undefined,
  amountAbs: bigint,
  kinds: MovementKind[]
): PolyxEntry[] =>
  account
    ? getLedgerEntries(blockId)
        .ofAccount(account)
        .filter(row => kinds.includes(row.kind) && row.amountAbs === amountAbs)
    : [];

/**
 * Whether the block's events show extrinsic `extrinsicIdx` emitting `section.method`.
 *
 * The fee paths decide which runtime they are in from what the extrinsic actually emitted, not from
 * the block's reported spec version. That label comes from the dictionary's map of spec ranges,
 * which starts each runtime late — by up to a few hundred blocks on testnet — so a gate on it
 * misfiles the blocks either side of an upgrade: a fee counted twice, or not at all. What the
 * runtime emitted cannot be mislabelled.
 */
export const extrinsicEmits = (
  block: SubstrateBlock,
  extrinsicIdx: number | undefined,
  section: string,
  method: string
): boolean =>
  extrinsicIdx !== undefined &&
  extrinsicEventIndices(block, extrinsicIdx).some(index => {
    const { event } = (block.events ?? [])[index];

    return event.section === section && event.method === method;
  });

export const stakingStash = (decoded: Record<string, Codec>): string | undefined =>
  firstText(decoded, ['stash', 'account', 'staker', 'who']);
