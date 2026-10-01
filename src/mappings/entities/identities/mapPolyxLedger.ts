import { Codec } from '@polkadot/types/types';
import { hexHasPrefix } from '@polkadot/util';
import { SubstrateBlock, SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import { decodeEvent, optionalField } from '../../../decode';
import {
  Account,
  AccountBalance,
  AnomalyKind,
  EntryDirection,
  EventIdEnum,
  HoldEntry,
  HoldReason,
  Identity,
  MovementKind,
  PolyxEntry,
  PolyxPool,
  Proposal,
  ProposalVote,
  Subsidy,
} from '../../../types';
import {
  bytesToString,
  getAllByFields,
  getBigIntValue,
  getProposerValue,
  getTextValue,
  padId,
  padNumericId,
} from '../../../utils';
import { recordAnomaly } from '../../../utils/anomaly';
import { hexToString, is8xChain } from '../../../utils/common';
import { blockAuthor } from '../../../utils/blockAuthor';
import {
  readRewardDestination,
  readStakingLock,
  resolveController,
  resolveLegacyRewardDestination,
} from '../../../utils/staking';
import { getAccountKey, ledgerAccount } from '../../../utils/accounts';
import { getEventParams } from '../../../utils/events';
import { extractArgs, HandlerArgs } from '../common';
import { getAccountId, systematicIssuers } from '../../consts';
import { reconcileAccount, reconcilePending } from './reconcilePolyx';
import { storageEntriesAtParent } from '../../../utils/storageAtParent';
import { resolveFeePayer } from './feePayer';
import { extrinsicEventIndices } from '../../blockContext';

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

/**
 * The balance row for an address, created empty when the ledger has not seen it before.
 *
 * Every balance mutation goes through here, which is also where a reconciliation queued by an
 * earlier block is flushed: at this point the current block has changed nothing yet, so the
 * derived side still matches the snapshot that was captured back then.
 */
export const loadBalance = async (
  address: string,
  identityId: string | undefined,
  blockEventId: string,
  block: SubstrateBlock
): Promise<AccountBalance> => {
  await reconcilePending(block);

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
 * The amount of the lock `lockId` on chain for `address`, from `balances.locks(who)` — `0` once
 * there is none, `undefined` on a failed read. Both eras keep `balances.locks`.
 */
export const readChainLock = async (
  address: string,
  lockId: string
): Promise<bigint | undefined> => {
  try {
    const raw = (await api.query.balances.locks(address)).toJSON() as
      | { id?: string; amount?: string | number }[]
      | null;

    if (!Array.isArray(raw)) {
      return undefined;
    }

    const lock = raw.find(entry => {
      const id = entry.id ?? '';
      return (hexHasPrefix(id) ? hexToString(id) : id) === lockId;
    });

    return lock ? BigInt(lock.amount ?? 0) : BigInt(0);
  } catch {
    return undefined;
  }
};

/**
 * The `'staking '` lock still present on chain for `address` — `0` once there is none.
 *
 * Needed on v8 because the lock → hold migration runs in two passes some ~420k blocks apart: the
 * first adds the `Staking` hold and leaves the old lock in place, the second drops the lock. In
 * between, an account's chain `frozen` *is* that staking lock, and only reading the lock list says
 * so. `undefined` on a failed read.
 */
export const readChainStakingLock = (address: string): Promise<bigint | undefined> =>
  readChainLock(address, STAKING_LOCK_ID);

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
 * Used wherever a derived balance is replaced wholesale by a chain read — the in-flight
 * reconciler's drift correction and the genesis / partial-index seed. Attribution matters because
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
    balance.holds = holds;
  }

  const capped = (amount?: bigint): bigint => {
    const value = amount ?? BigInt(0);
    return value < frozen ? value : frozen;
  };
  const stakingPart = capped(stakingLock);
  const pipsPart = capped(pipsLock);
  const explained = stakingPart > pipsPart ? stakingPart : pipsPart;

  balance.locks = [
    ...(stakingPart > BigInt(0)
      ? [{ lockId: STAKING_LOCK_ID, amount: stakingPart, reasons: 'staking' }]
      : []),
    ...(pipsPart > BigInt(0) ? [{ lockId: PIPS_LOCK_ID, amount: pipsPart, reasons: 'pips' }] : []),
    ...(frozen > explained ? [{ lockId: RESIDUAL_LOCK_ID, amount: frozen }] : []),
  ];

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
  /** who the value came from, for a credit with no debit side here (a slash's reporter reward) */
  source?: string;
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
  const balance = await loadBalance(address, account.identityId, blockEventId, block);

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
  args: HandlerArgs
): Promise<void> => {
  const total = await readStakingLock(stash, args.blockId);

  if (total === undefined) {
    await adjustLock(stash, STAKING_LOCK_ID, fallbackDelta, args.blockEventId, 'staking');
    return;
  }

  await setLock(stash, STAKING_LOCK_ID, total, args.blockEventId, 'staking');
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
    const balance = await loadBalance(who, undefined, blockEventId, block);
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
 * The entry among `candidates` written closest *before* the current event — the one a paired event
 * refers to when several match on account and amount. Block-scoped ids are zero-padded, so
 * `movementId` order is event order.
 */
const nearestPreceding = (candidates: PolyxEntry[], args: HandlerArgs): PolyxEntry | undefined =>
  candidates
    .filter(entry => entry.movementId < args.blockEventId)
    .sort((a, b) => (a.movementId < b.movementId ? 1 : -1))[0];

/** The `movementId` of the event immediately before the current one in this block. */
const previousEventId = (args: HandlerArgs): string =>
  `${args.blockId}/${padId(String(args.eventIdx - 1))}`;

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

  // Moves nothing. Pre-v8 every dropped positive imbalance touches the block reward reserve, which,
  // empty, is recreated with `Endowed(brr, 0)` each time: 210,000 of them on a testnet resync, each
  // writing an entry and a new balance version, 27,000 for the reserve alone.
  if (amount === BigInt(0)) {
    return;
  }

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
      ? await findExtrinsicEntries(args, MovementKind.Endowment, to, amount)
      : (await findBlockEntries(args.blockId, to, amount, [MovementKind.Endowment])).filter(
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

  const unmemoed = (await findExtrinsicEntries(args, MovementKind.Transfer, to, amount)).find(
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
  const reward = await findBlockEntries(args.blockId, who, amount, [MovementKind.StakingReward]);

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
  const endowedJustBefore = (
    await findBlockEntries(args.blockId, who, amount, [MovementKind.Endowment])
  ).some(entry => entry.movementId === previousEventId(args));

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
 * `identity.InitialPOLYX` for the block's runtime — 100,000 POLYX on testnet, 0 on mainnet and
 * develop. A `#[pallet::constant]`, so read from metadata rather than assumed per chain.
 * `undefined` when the runtime does not expose it.
 */
const initialPolyx = (): bigint | undefined => {
  try {
    const raw = (
      api.consts as unknown as Record<string, Record<string, Codec | undefined> | undefined>
    ).identity?.initialPOLYX;

    return raw === undefined || raw === null ? undefined : BigInt(raw.toString());
  } catch {
    return undefined;
  }
};

/**
 * The POLYX `identity.do_register_did` gives a new identity's primary key.
 *
 * Pre-v8 the grant was invisible. `do_register_did` calls `deposit_creating(&sender,
 * InitialPOLYX)` and then emits `DidCreated` — and Polymesh's own balances pallet emits nothing for
 * a deposit, only `Endowed` when the account is new. So a key that already held POLYX before its
 * identity was registered (common on testnet: fund a key, then register it) received 100,000 POLYX
 * with no balance event at all. A resync found one such account exactly 100,000 POLYX short.
 *
 * `DidCreated` names the same account right after, so the grant is credited here — unless:
 * - the account was new, in which case the `Endowed` for exactly this amount already credited it;
 * - the chain is v8, whose upstream `Currency::deposit_creating` emits `Deposit`, already a `Mint`;
 * - the grant is 0, as on mainnet;
 * - the key is a systematic issuer, whose identity comes from `do_register_id`, which grants nothing.
 */
export const handleIdentityGrant = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);

  if (is8xChain(args.block)) {
    return;
  }

  const decoded = decodeEvent(event);
  const primaryKey = firstText(decoded, ['primaryKey']);

  if (!primaryKey) {
    return;
  }

  const grant = initialPolyx();

  if (!grant || grant <= BigInt(0)) {
    return;
  }

  const systematic = Object.values(systematicIssuers).some(
    issuer => getAccountId(issuer.accountId, api.registry.chainSS58) === primaryKey
  );

  if (systematic) {
    return;
  }

  // `create_child_identity(ies)` emits `DidCreated` for the child too, but through
  // `base_create_child_identity`, which grants nothing (v6.1.0, v7.4.0): only
  // `register_did_without_cdd` does. The child is told apart by the `ParentDid` it stores before
  // the event; a testnet resync credited a child's key 100,000 POLYX it never received.
  const did = firstText(decoded, ['did']);

  if (did && (await isChildIdentity(did))) {
    return;
  }

  const [endowed] = args.extrinsicId
    ? await findExtrinsicEntries(args, MovementKind.Endowment, primaryKey, grant)
    : await findBlockEntries(args.blockId, primaryKey, grant, [MovementKind.Endowment]);

  if (endowed) {
    return;
  }

  await postTransition(args, {
    to: { address: primaryKey, pool: PolyxPool.Free },
    amount: grant,
    kind: MovementKind.Mint,
  });
};

/**
 * `bridge.Bridged(did, BridgeTx { nonce, recipient, amount, tx_hash })` — POLY locked on Ethereum,
 * POLYX minted here. The bridge pallet (removed in v7.0.0) credits it with
 * `balances::deposit_creating(recipient, amount)` (verified at v3.3.0 and v6.0.0), and the pre-v8
 * balances pallet emits nothing for a deposit, so the only record of the credit is this event: a
 * testnet resync found an account 30,000 POLYX short from one bridge transfer.
 *
 * A recipient with no account yet does get `Endowed(recipient, amount)` from the same deposit, and
 * that endowment already is the credit. It is emitted inside `deposit_creating`, then dropping the
 * imbalance touches the block reward reserve (which emits its own `Endowed(brr, 0)` the first time),
 * then `Bridged` — so the endowment is one or two events back.
 *
 * Where the POLYX came from is not recorded here: dropping the imbalance takes it from the block
 * reward reserve while that has free balance, and mints the rest, with no event either way.
 */
export const handleBridgeMint = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);

  if (is8xChain(args.block)) {
    return;
  }

  const tx = (args.params[1] as Codec | undefined)?.toJSON() as
    | { recipient?: string; amount?: string | number }
    | null
    | undefined;

  if (!tx?.recipient || tx.amount === undefined) {
    return;
  }

  const recipient = getAccountKey(tx.recipient, api.registry.chainSS58);
  const amount = BigInt(String(tx.amount));

  const recentEventIds = new Set(
    [1, 2].map(back => `${args.blockId}/${padId(String(args.eventIdx - back))}`)
  );
  const endowed = (
    await findBlockEntries(args.blockId, recipient, amount, [MovementKind.Endowment])
  ).some(entry => recentEventIds.has(entry.movementId));

  if (endowed) {
    return;
  }

  await postTransition(args, {
    to: { address: recipient, pool: PolyxPool.Free },
    amount,
    kind: MovementKind.Mint,
  });
};

/** `identity.parentDid(did)` is set — `false` on a runtime without it (before v6.1) or a failed read. */
const isChildIdentity = async (did: string): Promise<boolean> => {
  // Not in the v8 type augmentation (the storage was dropped with child identities there).
  const identity = (
    api.query as unknown as Record<
      string,
      { parentDid?: (id: string) => Promise<{ isSome?: boolean }> } | undefined
    >
  ).identity;

  try {
    return (await identity?.parentDid?.(did))?.isSome === true;
  } catch {
    return false;
  }
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

  // account reaping — always reconcile the reaped account against chain state
  await reconcileAccount(account, args.blockId, args.block, {
    force: true,
    eventIdx: args.eventIdx,
  });
};

// ---------------------------------------------------------------------------------------------
// BalanceSet — a checkpoint, not a movement
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
  const balance = await loadBalance(who, account.identityId, blockEventId, block);

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

  // From 5.0.0 `unsafe_disbursement` pays by `Currency::transfer`, which emits
  // `balances.Transfer{treasury → recipient}`, and emits this event straight after it. Matched on
  // the block, not the extrinsic: `disbursement` is root-only, so it runs from a PIP's enactment,
  // usually as the block initialises, with no extrinsic at all. Testnet block 6,527,686 paid
  // 11 × 1 unit that way and each was counted twice. And on the *immediately preceding* event, so
  // equal payments to one recipient each consume their own transfer.
  const treasury = treasuryPalletAccount();
  const existingTransfer = (
    await findBlockEntries(args.blockId, toAddress, amount, [MovementKind.Transfer])
  ).find(
    entry => entry.movementId === previousEventId(args) && entry.counterpartyAddress === treasury
  );

  if (existingTransfer) {
    // relabel both sides of the transfer rather than writing a second movement
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
    from: { address: treasury, pool: PolyxPool.Free },
    to: toAddress ? { address: toAddress, pool: PolyxPool.Free } : undefined,
    amount,
    kind: MovementKind.TreasuryDisbursement,
  });
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
  const burns = pairedWithBalanceEvents
    ? await getAllByFields<PolyxEntry>('PolyxEntry', [
        ['extrinsicId', '=', args.extrinsicId],
        ['kind', '=', MovementKind.Burn],
      ])
    : [];

  if (pairedWithBalanceEvents && (await refileFeeWithdrawal(args, burns, who, fee))) {
    return;
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

    await creditBlockAuthor(args, fee, treasuryShareAt(args.block, splitAt, args.extrinsicIdx));
  }
};

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

/**
 * The treasury's cut of a fee, announced by the event at `index` — `0` when that event is not one.
 *
 * Up to v5.4.0 the runtime split every fee rather than paying it all to the block author: 80% went
 * to the treasury, which announced it as `treasury.TreasuryReimbursement`, and the remaining 20% to
 * the author, unannounced. The treasury's event sits at a fixed point beside the fee it came from —
 * right after a protocol fee's `FeeCharged`, and right before a transaction fee is settled (its
 * `TransactionFeePaid` from v5.4.0, or the extrinsic's closing event before it) — so its position
 * says which fee it is a cut of. From v5.4.2 fees go to the author whole and no such event appears.
 */
export const treasuryShareAt = (
  block: SubstrateBlock,
  index: number,
  extrinsicIdx?: number
): bigint => {
  const record = (block.events ?? [])[index];

  if (
    extrinsicIdx === undefined ||
    record?.event.section !== 'treasury' ||
    record.event.method !== 'TreasuryReimbursement' ||
    !extrinsicEventIndices(block, extrinsicIdx).includes(index)
  ) {
    return BigInt(0);
  }

  return BigInt(record.event.data[1].toString());
};

/**
 * Pays a pre-v8 fee to the block author — what is left of it once the treasury's announced cut is
 * taken, which is all of it from v5.4.2 (see `treasuryShareAt`). With no author the chain drops
 * that part instead, so nothing is credited. A treasury event larger than the fee cannot be its
 * cut, and leaves the fee whole.
 */
export const creditBlockAuthor = async (
  args: HandlerArgs,
  fee: bigint,
  treasuryShare: bigint
): Promise<void> => {
  const author = await blockAuthor(args.block);
  const amount = treasuryShare <= fee ? fee - treasuryShare : fee;

  if (!author || amount === BigInt(0)) {
    return;
  }

  await postTransition(args, {
    to: { address: author, pool: PolyxPool.Free },
    amount,
    kind: MovementKind.BlockAuthorFee,
  });
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
 * Which burn is the fee's is decided by where it sits, not by its size: the call itself can burn
 * from the same account, and picking by amount could re-file that burn as the fee instead. The two
 * fees are withdrawn at fixed points. A transaction fee is withdrawn before the call runs, so it is
 * the payer's first burn in the extrinsic; a protocol fee is withdrawn by the call, immediately
 * before `FeeCharged` announces it. The amount is only checked, never searched on: a transaction
 * fee's withdrawal is the estimate, never less than what was finally charged, and a protocol fee's
 * is exact.
 */
const refileFeeWithdrawal = async (
  args: HandlerArgs,
  burns: PolyxEntry[],
  payer: string,
  fee: bigint
): Promise<boolean> => {
  const own = burns.filter(row => row.accountId === payer);
  const isProtocolFee = args.eventId === EventIdEnum.FeeCharged;
  const withdrawal = isProtocolFee
    ? nearestPreceding(own, args)
    : [...own].sort((a, b) => (a.movementId < b.movementId ? -1 : 1))[0];

  if (!withdrawal || (isProtocolFee ? withdrawal.amountAbs !== fee : withdrawal.amountAbs < fee)) {
    return false;
  }

  await relabelEntry(withdrawal, MovementKind.Fee, args.blockEventId);

  const refunded = withdrawal.amountAbs - fee;

  if (refunded > BigInt(0)) {
    const [refund] = await findExtrinsicEntries(args, MovementKind.Mint, payer, refunded);

    if (refund) {
      await relabelEntry(refund, MovementKind.Fee, args.blockEventId);
    }
  }

  return true;
};

/**
 * The account a fee event's fee was taken from, when no withdrawal of it was recorded.
 *
 * From v5.4.1 (spec 5004001) both fee events name it, subsidiser included (`fee_key`), so it is
 * taken as is: applying a subsidy again charged a subsidised paying key's own subsidiser instead
 * (testnet block 14,872,581, where a two-level subsidy moved 25 POLYX on to the wrong account).
 * Checked on testnet at 5004001, 5004002, 6002010, 7000005 and 7003003, where the named account
 * fell by the fee and the signer did not; v8 names `fee_key` too.
 *
 * Before it, each named someone else:
 * - `protocolFee.FeeCharged` the payer, before its subsidy (`check_subsidy(account, fee, None)`
 *   then `FeeCharged(account, …)`), which covers any call.
 * - `transactionPayment.TransactionFeePaid`, only on v5.4.0 (spec 5004000), the signer, while the
 *   fee was charged as before v5.4 (see `resolveFeeAccount`). So a call someone else pays for,
 *   such as `relayer.accept_paying_key`, left its signer low and its payer high.
 *
 * Gated on `block.specVersion`, which `ensureTrueSpecVersion` has already set to the runtime that
 * executed the block. So the subsidy is looked up only on the runtimes whose events left it out.
 */
const chargedFor = async (args: HandlerArgs, who: string): Promise<string> => {
  if (args.block.specVersion >= 5_004_001) {
    return who;
  }
  if (args.eventId === EventIdEnum.FeeCharged) {
    return (await activeSubsidiser(who)) ?? who;
  }

  return args.extrinsic ? resolveFeeAccount(args.extrinsic) : who;
};

/** The paying key of `user`'s accepted, unremoved subsidy, from the indexed `Subsidy` rows. */
export const activeSubsidiser = async (user: string): Promise<string | undefined> => {
  const subsidies = await Subsidy.getByBeneficiaryAccountId(user, { limit: 10 });

  return subsidies.find(subsidy => subsidy.isAccepted && !subsidy.isRemoved)?.payingAccountId;
};

/**
 * The account a transaction fee was taken from, up to v5.4.0, when the runtime announced no fee
 * or named the signer: the payer `get_valid_payer` chose (`resolveFeePayer`), or the paying key of
 * that payer's subsidy (`check_subsidy(&payer_key, …)`). A subsidy covers every call but the
 * relayer's own: a subsidised payer's call to any other unsubsidised pallet is rejected, so never
 * reaches the chain.
 */
export const resolveFeeAccount = async (extrinsic: SubstrateExtrinsic): Promise<string> => {
  const payer = await resolveFeePayer(extrinsic);
  const subsidiser = await activeSubsidiser(payer);

  return subsidiser && extrinsic.extrinsic.method.section.toLowerCase() !== 'relayer'
    ? subsidiser
    : payer;
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
 * `staking.payee(stash)` is read from chain storage — measured on mainnet to matter for a
 * large share of pre-v8 rewards.
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

  if (is8x) {
    // v8: `dest: Staked` restakes via the paired `balances.Held{Staking}`, so no lock work here.
    const dest = optionalField(decoded, 'dest');
    const { destination, account } = readRewardDestination(
      (dest?.toJSON() ?? null) as Parameters<typeof readRewardDestination>[0]
    );

    if (destination === 'Account' && account) {
      return { recipient: account, restaked: false };
    }

    /**
     * v8 `make_payout` still honours the deprecated `Controller` payee — it mints to
     * `bonded(stash)`, not to the stash. The variant carries no account, and as a unit variant it
     * decodes to a bare string, so the old object-only check sent every such reward to the stash:
     * the stash ran high and the controller low by exactly the reward total (57 rewards,
     * 141,981,208, on one testnet account).
     */
    if (destination === 'Controller') {
      const controller = await resolveController(stash, blockId).catch(() => stash);

      return { recipient: controller, restaked: false };
    }

    return { recipient: stash, restaked: false };
  }

  const { rewardDestination, rewardDestinationAccount } = await resolveLegacyRewardDestination(
    stash,
    blockId
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
    await findBlockEntries(args.blockId, recipient, amount, [
      MovementKind.Mint,
      MovementKind.Endowment,
    ]),
    args
  );

  if (paid) {
    await relabelEntry(paid, MovementKind.StakingReward, args.blockEventId, { eraIndex });
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
    await syncStakingLock(recipient, amount, args);
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
    await syncStakingLock(stash, -amount, args);
    await creditSlashReporters(args, stash, amount);
  }
};

/** One `staking.UnappliedSlash`: a slash the chain holds back until its era comes due. */
interface DeferredSlash {
  era: number;
  validator: string;
  own: bigint;
  reporters: string[];
  payout: bigint;
}

/**
 * The slashes still deferred as `block` begins, which is the set it applies from; `undefined` when
 * that state can't be read (see `storageEntriesAtParent`).
 *
 * Read at the parent hash, because applying a slash takes it out of storage, so the block's own
 * state no longer holds it.
 */
const deferredSlashesBefore = async (
  block: SubstrateBlock
): Promise<DeferredSlash[] | undefined> => {
  const entries = await storageEntriesAtParent(block, 'staking', 'unappliedSlashes');

  // a key whose era didn't decode leaves its slashes unplaceable, which is not "none deferred"
  if (entries?.some(({ args }) => args.length === 0)) {
    return undefined;
  }

  return entries?.flatMap(({ args: [era], value }) => {
    const deferred = value as unknown as {
      validator: Codec;
      own: Codec;
      reporters: Codec[];
      payout: Codec;
    }[];

    return deferred.map(slash => ({
      era: Number(getBigIntValue(era)),
      validator: getTextValue(slash.validator),
      own: getBigIntValue(slash.own),
      reporters: slash.reporters.map(reporter => getTextValue(reporter)),
      payout: getBigIntValue(slash.payout),
    }));
  });
};

/**
 * Pays a pre-v8 slash's reporters their share. The chain announces nothing for it.
 *
 * `slashing::apply_slash` takes the slash from the validator and its nominators, each announced
 * by `staking.Slash`, then `pay_reporters` gives the offence's reporters up to the deferred
 * slash's `payout`, split evenly, through `resolve_creating`, which emits nothing. The rest,
 * including any remainder of the split, goes to the treasury as one `TreasuryReimbursement`. So
 * the reporters' share left the validator and arrived nowhere. On testnet that left the one
 * reporter of the era-2159 slash 637.5 POLYX short from block 7,751,343.
 *
 * Done once per deferred slash, on the validator's own `Slash`, which comes first: a nominator's
 * `Slash` names an account that is not the deferred slash's validator. Of the deferred slashes
 * that match, the oldest era is the one applied, because eras are applied in order.
 *
 * Checked against the treasury's event. The slashes of this offence, less what the reporters were
 * paid, must be what the treasury received; anything else is recorded, not guessed at.
 */
/**
 * What applying a slash took, from the validator's `Slash` at `eventIdx` and the nominators' after
 * it, up to the treasury's receipt; and what the treasury announced it received, if it did.
 */
const slashProceeds = (
  block: SubstrateBlock,
  eventIdx: number
): { slashed: bigint; announced?: bigint } => {
  const records = (block.events ?? []).slice(eventIdx);
  const treasuryAt = records.findIndex(
    ({ event }) => event.section === 'treasury' && event.method === 'TreasuryReimbursement'
  );
  const upToTreasury = treasuryAt === -1 ? records : records.slice(0, treasuryAt);
  const slashed = upToTreasury
    .filter(({ event }) => event.section === 'staking' && event.method === 'Slash')
    .reduce((sum, { event }) => sum + BigInt(event.data[1].toString()), BigInt(0));

  return {
    slashed,
    announced: treasuryAt === -1 ? undefined : BigInt(records[treasuryAt].event.data[1].toString()),
  };
};

const creditSlashReporters = async (
  args: HandlerArgs,
  validator: string,
  own: bigint
): Promise<void> => {
  const { block, eventIdx } = args;
  const deferred = await deferredSlashesBefore(block);

  if (!deferred) {
    await recordAnomaly({
      kind: AnomalyKind.UnreadableValue,
      detail: `staking.Slash of ${own} on ${validator}: the deferred slashes could not be read, so its reporters were not paid`,
      block,
      eventIdx,
    });
    return;
  }

  const candidates = deferred.filter(slash => slash.validator === validator);

  if (candidates.length === 0) {
    // A nominator's share of someone else's slash. Its validator's `Slash` paid the reporters.
    return;
  }

  const applied = candidates.filter(slash => slash.own === own).sort((a, b) => a.era - b.era)[0];

  if (!applied) {
    await recordAnomaly({
      kind: AnomalyKind.UnreadableValue,
      detail: `staking.Slash of ${own} on ${validator} matches no deferred slash, so its reporters were not paid`,
      block,
      eventIdx,
    });
    return;
  }

  const { slashed, announced } = slashProceeds(block, eventIdx);

  const reporters = applied.reporters;
  const perReporter =
    reporters.length === 0
      ? BigInt(0)
      : (applied.payout < slashed ? applied.payout : slashed) / BigInt(reporters.length);

  if (perReporter > BigInt(0)) {
    if (reporters.length > 1) {
      // Every reporter's credit is filed against this one event, and an entry's id carries no
      // account, so each overwrites the one before. The balances still come out right.
      await recordAnomaly({
        kind: AnomalyKind.UnreadableValue,
        detail: `staking.Slash on ${validator} paid ${reporters.length} reporters; only the last one's PolyxEntry survives`,
        block,
        eventIdx,
      });
    }

    for (const reporter of reporters) {
      await postTransition(args, {
        to: { address: reporter, pool: PolyxPool.Free },
        amount: perReporter,
        kind: MovementKind.StakingReward,
        source: validator,
      });
    }
  }

  const toTreasury = slashed - perReporter * BigInt(reporters.length);

  if (announced !== toTreasury) {
    await recordAnomaly({
      kind: AnomalyKind.UnreadableValue,
      detail: `staking.Slash on ${validator}: ${slashed} slashed and ${
        perReporter * BigInt(reporters.length)
      } paid to reporters should leave ${toTreasury} for the treasury, which announced ${
        announced ?? 'nothing'
      }`,
      block,
      eventIdx,
    });
  }
};

const ensureBalanceRow = async (
  address: string,
  blockId: string,
  datetime: Date,
  blockEventId: string,
  block: SubstrateBlock
): Promise<void> => {
  await ledgerAccount(address, blockId, datetime);
  const balance = await loadBalance(address, undefined, blockEventId, block);
  await balance.save();
};

// ---------------------------------------------------------------------------------------------
// PIPs deposits — a pre-v8 lock with no balance event
// ---------------------------------------------------------------------------------------------

/**
 * Sets `address`'s `'pips    '` lock to what the chain holds after this block.
 *
 * The pips pallet locks proposal and vote deposits with `Currency::increase_lock` /
 * `reduce_lock(PIPS_LOCK_ID, …)` (verified at v3.3.0, v4.1.0, v6.0.0, v7.4.0 and v8.0.0), and the
 * pre-v8 balances pallet emits nothing for a lock change, so the deposit was never on the ledger:
 * a testnet resync found accounts reporting `frozen` 0 against a chain value of exactly the
 * 2,000 POLYX minimum proposal deposit. The lock is an aggregate over every PIP the account has a
 * deposit on, so it is read back rather than accumulated from the event amounts.
 *
 * v8 is skipped: upstream `update_locks` emits `Locked`/`Unlocked` for the change in `frozen`,
 * which `handleBalanceLocked`/`handleBalanceUnlocked` already record.
 */
const syncPipsLock = async (address: string, args: HandlerArgs): Promise<void> => {
  const amount = await readChainLock(address, PIPS_LOCK_ID);

  if (amount === undefined) {
    return;
  }

  await ensureBalanceRow(
    address,
    args.blockId,
    args.block.timestamp,
    args.blockEventId,
    args.block
  );
  await setLock(address, PIPS_LOCK_ID, amount, args.blockEventId, 'pips');
};

/**
 * `pips.ProposalCreated(did, proposer, pipId, deposit, …)` locks a community proposer's deposit;
 * `pips.Voted(did, voter, pipId, aye, deposit)` raises or lowers the voter's. A committee proposer
 * has no account and no deposit.
 */
export const handlePipsDeposit = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);

  if (is8xChain(args.block)) {
    return;
  }

  const rawAccount = args.params[1] as Codec;
  const address =
    args.eventId === EventIdEnum.ProposalCreated
      ? communityProposer(rawAccount)
      : getTextValue(rawAccount);

  if (address) {
    await syncPipsLock(address, args);
  }
};

const communityProposer = (rawProposer: Codec): string | undefined => {
  const proposer = getProposerValue(rawProposer);

  return proposer.type === 'Community' ? proposer.value : undefined;
};

/**
 * `pips.ProposalRefund(did, pipId, total)` — the deposits on `pipId` are unlocked, but the event
 * names neither the depositors nor their amounts, and by the time it fires the chain has already
 * removed them from `Deposits`. The depositors are the community proposer and every voter, both
 * already indexed, so each is re-read. From v7 a refund can be split over several blocks
 * (`remove_pending_storage` takes a bounded batch); an account not refunded yet still reads its
 * lock, so re-reading everyone is safe.
 */
export const handleProposalRefund = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);

  if (is8xChain(args.block)) {
    return;
  }

  const pipId = padNumericId(getTextValue(args.params[1] as Codec));
  const [proposal, votes] = await Promise.all([
    Proposal.get(pipId),
    getAllByFields<ProposalVote>('ProposalVote', [['proposalId', '=', pipId]]),
  ]);

  // `ProposalVote.account` is the raw public key; balances are keyed by SS58 address.
  const addresses = new Set<string>(
    votes.map(vote => getAccountKey(vote.account, api.registry.chainSS58))
  );

  if (proposal?.proposer.type === 'Community') {
    addresses.add(proposal.proposer.value);
  }

  for (const address of addresses) {
    await syncPipsLock(address, args);
  }
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

  await ensureBalanceRow(stash, args.blockId, args.block.timestamp, args.blockEventId, args.block);
  await syncStakingLock(stash, amountOf(decoded), args);
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

  await syncStakingLock(stash, -amountOf(decoded), args);
};
