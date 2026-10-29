import { Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import {
  AccountBalance,
  AnomalyKind,
  EventIdEnum,
  HoldReason,
  MovementKind,
  PolyxEntry,
  PolyxPool,
  Proposal,
  ProposalVote,
} from '../../../types';
import {
  getAllByFields,
  getBigIntValue,
  getProposerValue,
  getTextValue,
  padNumericId,
} from '../../../utils';
import { readOrAnomaly, recordAnomaly } from '../../../utils/anomaly';
import { is8xChain } from '../../../utils/common';
import { blockAuthor } from '../../../utils/blockAuthor';
import {
  readStakingLedger,
  readStakingLock,
  resolveLegacyRewardDestination,
} from '../../../utils/staking';
import { getAccountKey, ledgerAccount } from '../../../utils/accounts';
import { optionOf } from '../../../utils/codec';
import { findStorage } from '../../../utils/legacyQuery';
import { extractArgs, HandlerArgs } from '../common';
import { getAccountId, systematicIssuers } from '../../consts';
import {
  activeEraAt,
  APPLY_ERA_KEYS_FROM,
  deferredSlashesBefore,
  isFirstSlashOf,
  placeSlash,
  slashedBefore,
} from '../../../utils/deferredSlashes';
import {
  adjustHold,
  findBlockEntries,
  holdsOf,
  findExtrinsicEntries,
  firstText,
  loadBalance,
  locksOf,
  PIPS_LOCK_ID,
  postTransition,
  readChainFrozen,
  readChainLock,
  readChainStakingLock,
  recentEventIds,
  setLock,
  STAKING_LOCK_ID,
  stakingStash,
  TransitionOptions,
} from './ledgerCore';

/**
 * The POLYX ledger before v8, where Polymesh ran its own balances pallet and much of what moved
 * POLYX announced nothing: staking bonded with a lock, deposits drew on the block reward reserve,
 * fees were split with the treasury, and slash reporters, identity grants, bridge mints and PIP
 * deposits went unannounced. Each is reconstructed here, and none applies from v8 on, except the
 * clean-up of a staking lock as v8 moves it to a hold.
 */

// Staking — bonded with a lock

/**
 * Sets the pre-v8 `'staking '` lock on `stash` to `staking.ledger.total` read from chain.
 *
 * The chain read is authoritative — it already accounts for the max-bond cap, the rounding of a
 * compounded `Staked` reward, unbonding chunks, and slashes.
 *
 * A ledger that doesn't decode with the block's metadata is recorded as an anomaly and leaves the
 * lock as it was.
 */
export const syncStakingLock = async (stash: string, args: HandlerArgs): Promise<void> => {
  const total = await readOrAnomaly(args, `the staking lock of ${stash} was left as it was`, () =>
    readStakingLock(stash, args.blockId)
  );

  if (total === undefined) {
    return;
  }

  await setLock(stash, STAKING_LOCK_ID, total, args.blockEventId, 'staking');
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

  await ensureBalanceRow(stash, args.blockId, args.block.timestamp, args.blockEventId);
  await syncStakingLock(stash, args);
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

  await syncStakingLock(stash, args);
};

/**
 * The account a pre-v8 reward was paid to. `Rewarded` carries only the stash, so its payee is read
 * from chain storage. A `Staked` payee restakes: the reward lands in `free` and is locked at once,
 * with no `staking.Bonded`, so the caller raises the lock.
 */
export const legacyRewardRecipient = async (
  stash: string,
  blockId: string,
  block?: SubstrateBlock,
  eventIdx?: number
): Promise<{ recipient: string; restaked: boolean }> => {
  const { rewardDestination, rewardDestinationAccount } = await resolveLegacyRewardDestination(
    stash,
    blockId,
    block,
    eventIdx
  );

  return {
    recipient: rewardDestinationAccount ?? stash,
    restaked: rewardDestination === 'Staked',
  };
};

/**
 * `balances.Unlocked` on v8 that is the lock → hold migration removing a pre-v8 `'staking '` lock:
 * the migration emits `Upgraded`, the paired `Held{Staking}` (the `free → reserved` movement) and
 * `Unlocked{who, amount}` for the lock, in no extrinsic of the staker's own. Nothing on v8 creates
 * a `'staking '` lock, so an account that still has one is a candidate for migration; but any other
 * lock lowered on it emits an `Unlocked` too, and clearing the staking lock for that would leave the
 * other one too high.
 *
 * An `Unlocked` is the fall in what the account's locks freeze (their maximum), so it is the
 * migration's only when it is exactly the fall removing the staking lock causes: the lock's amount
 * when it stood alone, or its excess over the highest other lock. The lock's own amount also
 * counts: the migration's `Held{Staking}` has already capped the indexed lock at what the chain
 * freezes, and the `Unlocked` reports that capped amount, which the excess no longer matches. Any
 * other amount is another lock's, and is left to the generic lock. `false` when it is not the
 * migration's, or `who` has no such lock.
 */
export const clearMigratedStakingLock = async (
  who: string | undefined,
  blockEventId: string,
  amount: bigint
): Promise<boolean> => {
  const balance = who ? await AccountBalance.get(who) : undefined;
  const locks = balance ? locksOf(balance) : [];

  if (!who || !locks.some(lock => lock.lockId === STAKING_LOCK_ID)) {
    return false;
  }

  const highest = (list: typeof locks): bigint =>
    list.reduce((max, lock) => (lock.amount > max ? lock.amount : max), BigInt(0));
  const freed = highest(locks) - highest(locks.filter(lock => lock.lockId !== STAKING_LOCK_ID));
  const stakingLock = locks.find(lock => lock.lockId === STAKING_LOCK_ID)?.amount;

  if (amount !== freed && amount !== stakingLock) {
    return false;
  }

  await setLock(who, STAKING_LOCK_ID, BigInt(0), blockEventId, 'staking');
  return true;
};

/**
 * Re-reads the legacy `'staking '` lock of a stash the index still shows locked, as v8 moves it to
 * a `Staking` hold. Called on a `Staking` hold and on `staking.CurrencyMigrated`.
 *
 * The lock goes in two steps, neither announced for it. On mainnet the stash's chain `frozen` falls
 * to 0 when its stake is first held, while the lock is still listed in `balances.locks`; then
 * `do_migrate_currency` removes the lock and emits only `CurrencyMigrated` (a `remove_lock` that
 * lowers nothing emits no `Unlocked`). So the lock is what the chain lists, capped at what the
 * chain freezes: a listed lock that freezes nothing is not frozen.
 *
 * Locks or an account that don't decode with the block's metadata are recorded as an anomaly and
 * leave the lock as it was.
 */
export const syncMigratedStakingLock = async (
  who: string,
  { block, eventIdx, blockEventId }: HandlerArgs
): Promise<void> => {
  const balance = await AccountBalance.get(who);
  const locked = balance?.locks?.some(lock => lock.lockId === STAKING_LOCK_ID);

  if (!locked) {
    return;
  }

  const read = await readOrAnomaly(
    { block, eventIdx },
    `the staking lock of ${who} was left as it was`,
    async () => {
      const [listed, frozen] = await Promise.all([readChainStakingLock(who), readChainFrozen(who)]);

      return { listed, frozen };
    }
  );

  if (!read) {
    return;
  }

  const { listed, frozen } = read;
  const onChain = (listed ?? BigInt(0)) < frozen ? listed ?? BigInt(0) : frozen;

  await setLock(who, STAKING_LOCK_ID, onChain, blockEventId, 'staking');
};

/**
 * `staking.CurrencyMigrated { stash, force_withdraw }`: v8 has removed the stash's legacy lock.
 *
 * A stash that can't hold its whole stake has its ledger cut by `force_withdraw`, and its `Staking`
 * hold set to the new total. That hold isn't always the old one plus the `Held` the migration
 * emits: where the stash's old holds no longer decode (testnet's removed `contracts` pallet), the
 * chain rewrites the list with only the new hold, and the rest stays reserved under no hold. So the
 * hold is set from the ledger, which a force-withdraw is the only case to need.
 */
export const handleCurrencyMigrated = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const { blockId, blockEventId } = args;
  const decoded = decodeEvent(event);
  const stash = stakingStash(decoded);

  if (!stash) {
    return;
  }

  await syncMigratedStakingLock(stash, args);

  if (!decoded.forceWithdraw || getBigIntValue(decoded.forceWithdraw) === BigInt(0)) {
    return;
  }

  const ledger = await readOrAnomaly(args, `the Staking hold of ${stash} was left as it was`, () =>
    readStakingLedger(stash, blockId)
  );

  if (!ledger) {
    return;
  }

  const { total } = ledger;
  const balance = await AccountBalance.get(stash);
  const held =
    (balance ? holdsOf(balance) : []).find(hold => hold.reason === HoldReason.Staking)?.amount ??
    BigInt(0);

  await adjustHold(stash, HoldReason.Staking, total - held, blockEventId, event.block, event.idx);
};

// Slashes — the reporters' share

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
    .filter(
      ({ event }) =>
        event.section === 'staking' && (event.method === 'Slash' || event.method === 'Slashed')
    )
    .reduce((sum, { event }) => sum + BigInt(event.data[1].toString()), BigInt(0));

  return {
    slashed,
    announced: treasuryAt === -1 ? undefined : BigInt(records[treasuryAt].event.data[1].toString()),
  };
};

/**
 * Pays a pre-v8 slash's reporters their share. The chain announces nothing for it.
 *
 * `slashing::apply_slash` takes the slash from the validator and its nominators, each announced
 * by `staking.Slash` (`Slashed` from v7), then `pay_reporters` gives the offence's reporters up to
 * the deferred slash's `payout`, split evenly, through `resolve_creating`, which emits nothing. The
 * rest, including any remainder of the split, goes to the treasury as one `TreasuryReimbursement`.
 * So the reporters' share leaves the validator with no event to say where it went.
 *
 * Done once per deferred slash, on the first `Slash` it is applied from: the validator's own, which
 * comes first, unless its share was nothing, which the chain does not announce, and then the first
 * nominator's. A `Slash` is placed as `handleSlash` places it. Of the deferred slashes that match,
 * the one applied is the active era's from v7, the oldest before that (eras are applied in order).
 * A match is a deferred figure
 * at least the amount, not exactly it: the chain slashes no more than the ledger holds and
 * announces what it took.
 *
 * Checked against the treasury's event. The slashes of this offence, less what the reporters were
 * paid, must be what the treasury received; anything else is recorded, not guessed at. When a slash
 * is capped, the runtime also lowers the reporters' payout by the amount it could not take; that
 * reduction is not modelled, so the check records the difference.
 */
export const creditSlashReporters = async (
  args: HandlerArgs,
  stash: string,
  amount: bigint
): Promise<void> => {
  const { block, eventIdx } = args;
  const deferred = await deferredSlashesBefore(block);

  if (!deferred) {
    await recordAnomaly({
      kind: AnomalyKind.UnreadableValue,
      detail: `staking.Slash of ${amount} on ${stash}: the deferred slashes could not be read, so its reporters were not paid`,
      block,
      eventIdx,
    });
    return;
  }

  // the slash is capped at what the stash's ledger held, so the deferred figure is an upper bound
  const dueEra =
    block.specVersion >= APPLY_ERA_KEYS_FROM
      ? await activeEraAt(block, {
          eventIdx,
          moduleId: args.moduleId,
          eventId: args.eventId,
        })
      : undefined;
  // from v7.0 a slash is placed against the active era alone: with it unreadable (recorded above)
  // it is left unplaced, not put to the oldest era, which can be one that was never applied
  if (block.specVersion >= APPLY_ERA_KEYS_FROM && dueEra === undefined) {
    return;
  }

  const applied = placeSlash(deferred, block, eventIdx, stash, amount, dueEra)?.slash;

  if (!applied) {
    // The slashes of the era being applied, not of an older one never applied: a stash that is a
    // validator in a stale key only is a nominator here. A validator's own share that fits no
    // slash is recorded here. A nominator's share is paid for by the slash of its validator before
    // it, unless that validator's own share was nothing and announced none: then nothing in the
    // block pays the reporters, and nothing else records it.
    const era = dueEra ?? Math.min(...deferred.map(slash => slash.era));
    const validators = new Set(
      deferred.filter(slash => slash.era === era).map(slash => slash.validator)
    );
    const validatorSlashedBefore = slashedBefore(block, eventIdx).some(earlier =>
      validators.has(earlier)
    );

    if (validators.has(stash)) {
      await recordAnomaly({
        kind: AnomalyKind.UnreadableValue,
        detail: `staking.Slash of ${amount} on ${stash} matches no deferred slash, so its reporters were not paid`,
        block,
        eventIdx,
      });
    } else if (!validatorSlashedBefore) {
      await recordAnomaly({
        kind: AnomalyKind.UnreadableValue,
        detail: `staking.Slash of ${amount} on ${stash} matches no one deferred slash and no validator was slashed before it, so its reporters were not paid`,
        block,
        eventIdx,
      });
    }
    return;
  }

  if (!isFirstSlashOf(deferred, applied, block, eventIdx, dueEra)) {
    // an earlier `Slash` of this deferred slash paid the reporters
    return;
  }

  const { slashed, announced } = slashProceeds(block, eventIdx);

  const reporters = applied.reporters;
  const payout = applied.payout < slashed ? applied.payout : slashed;
  const perReporter = reporters.length === 0 ? BigInt(0) : payout / BigInt(reporters.length);

  if (perReporter > BigInt(0)) {
    // One credit per account, of its share for each time it is listed, so no two credits touch
    // the same balance. They are all filed against this one event, so each after the first is
    // tagged apart: an entry's id carries no account.
    const shares = new Map<string, bigint>();
    reporters.forEach(reporter =>
      shares.set(reporter, (shares.get(reporter) ?? BigInt(0)) + perReporter)
    );

    await Promise.all(
      [...shares].map(([reporter, amount], index) =>
        postTransition(
          args,
          {
            to: { address: reporter, pool: PolyxPool.Free },
            amount,
            kind: MovementKind.StakingReward,
            source: applied.validator,
          },
          { idTag: index === 0 ? undefined : `p${index}` }
        )
      )
    );
  }

  const toTreasury = slashed - perReporter * BigInt(reporters.length);

  if (announced !== toTreasury) {
    await recordAnomaly({
      kind: AnomalyKind.UnreadableValue,
      detail: `staking.Slash on ${applied.validator}: ${slashed} slashed and ${
        perReporter * BigInt(reporters.length)
      } paid to reporters should leave ${toTreasury} for the treasury, which announced ${
        announced ?? 'nothing'
      }`,
      block,
      eventIdx,
    });
  }
};

// The block reward reserve — what funded a deposit

const blockRewardReserve = (): string =>
  getAccountId(systematicIssuers.blockRewardReserve.accountId, api.registry.chainSS58);

/**
 * How much of a deposit the block reward reserve paid, before v8.
 *
 * Pre-v8 a deposit not offset by a withdrawal, such as a staking reward, a bridge mint or the
 * testnet identity grant, leaves a positive imbalance, and dropping it does not simply mint:
 * `drop_positive_imbalance` takes what it can from the reserve's free balance and mints only the
 * rest, with no event either way (balances pallet, v3.0.0 to v7.4.0; v8 has no reserve). Read from
 * the index's own reserve balance, which genesis seeds and every movement since keeps.
 *
 * On mainnet the reserve held nothing, so every deposit there is minted.
 */
const reserveShare = async (args: HandlerArgs, amount: bigint): Promise<bigint> => {
  if (is8xChain(args.block) || amount <= BigInt(0)) {
    return BigInt(0);
  }

  const free = (await AccountBalance.get(blockRewardReserve()))?.free ?? BigInt(0);

  if (free <= BigInt(0)) {
    return BigInt(0);
  }

  return free < amount ? free : amount;
};

/**
 * Credits `to` with a deposit as the runtime funded it: from the block reward reserve for its share
 * (see `reserveShare`), and minted for the rest. A deposit the reserve only part-covered is two
 * movements under one event, the minted one tagged apart.
 */
export const creditFromReserve = async (
  args: HandlerArgs,
  to: string,
  amount: bigint,
  kind: MovementKind,
  options: TransitionOptions = {}
): Promise<void> => {
  const fromReserve = await reserveShare(args, amount);

  if (fromReserve > BigInt(0)) {
    await postTransition(
      args,
      {
        from: { address: blockRewardReserve(), pool: PolyxPool.Free },
        to: { address: to, pool: PolyxPool.Free },
        amount: fromReserve,
        kind,
      },
      options
    );
  }

  if (amount > fromReserve) {
    await postTransition(
      args,
      { to: { address: to, pool: PolyxPool.Free }, amount: amount - fromReserve, kind },
      { ...options, idTag: fromReserve > BigInt(0) ? `${options.idTag ?? ''}m` : options.idTag }
    );
  }
};

/**
 * The reserve's side of a deposit already credited, by the `Endowed` the deposit emitted for an
 * account it created: the reserve's share (see `reserveShare`) debited, naming the account it
 * went to, and the credit marked as coming from the reserve.
 */
export const drawReserveFor = async (
  args: HandlerArgs,
  credit: PolyxEntry,
  kind: MovementKind,
  options: TransitionOptions = {}
): Promise<void> => {
  const fromReserve = await reserveShare(args, credit.amountAbs);

  if (fromReserve <= BigInt(0)) {
    return;
  }

  await postTransition(
    args,
    {
      from: { address: blockRewardReserve(), pool: PolyxPool.Free },
      amount: fromReserve,
      kind,
      destination: credit.accountId,
    },
    options
  );

  credit.counterpartyAddress = blockRewardReserve();
  await credit.save();
};

/**
 * Before 5.0.0 a disbursement was a withdrawal from the treasury, burned, and a deposit to the
 * recipient, which the block reward reserve funded first (see `reserveShare`). Net, the recipient
 * gained what the treasury lost, and the reserve's share was destroyed.
 */
export const burnDisbursedReserveShare = async (
  args: HandlerArgs,
  amount: bigint
): Promise<void> => {
  const burned = await reserveShare(args, amount);

  if (burned > BigInt(0)) {
    await postTransition(
      args,
      {
        from: { address: blockRewardReserve(), pool: PolyxPool.Free },
        amount: burned,
        kind: MovementKind.Burn,
      },
      { idTag: 'b' }
    );
  }
};

// Deposits with no balance event

/**
 * `identity.InitialPOLYX` for the block's runtime — 100,000 POLYX on testnet, 0 on mainnet and
 * develop. A `#[pallet::constant]`, so read from metadata rather than assumed per chain.
 * `undefined` when the runtime does not expose it.
 */
const initialPolyx = (): bigint | undefined => {
  try {
    const raw = api.consts.identity?.initialPOLYX;

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
 * with no balance event at all.
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
  // `base_create_child_identity`, which grants nothing: only `register_did_without_cdd` does. The
  // child is told apart by the `ParentDid` it stores before the event.
  const did = firstText(decoded, ['did']);

  if (did && (await isChildIdentity(did))) {
    return;
  }

  const [endowed] = args.extrinsicId
    ? findExtrinsicEntries(args, MovementKind.Endowment, primaryKey, grant)
    : findBlockEntries(args.blockId, primaryKey, grant, [MovementKind.Endowment]);

  // A deposit like any other, funded from the block reward reserve first (see `reserveShare`).
  if (endowed) {
    await drawReserveFor(args, endowed, MovementKind.Mint);
    return;
  }

  await creditFromReserve(args, primaryKey, grant, MovementKind.Mint);
};

/** `identity.parentDid(did)` is set — `false` on a runtime without it (before v6.1). */
const isChildIdentity = async (did: string): Promise<boolean> => {
  // the storage was dropped with child identities, so it is looked up by name
  const parentDid = findStorage('identity', 'parentDid');

  if (!parentDid) {
    return false;
  }

  return optionOf(await parentDid(did), 'identity.parentDid') !== undefined;
};

/**
 * `bridge.Bridged(did, BridgeTx { nonce, recipient, amount, tx_hash })` — POLY locked on Ethereum,
 * POLYX minted here. The bridge pallet (removed in v7.0.0) credits it with
 * `balances::deposit_creating(recipient, amount)`, and the pre-v8 balances pallet emits nothing
 * for a deposit, so the only record of the credit is this event.
 *
 * A recipient with no account yet does get `Endowed(recipient, amount)` from the same deposit, and
 * that endowment already is the credit. It is emitted inside `deposit_creating`, then dropping the
 * imbalance touches the block reward reserve (which emits its own `Endowed(brr, 0)` the first time),
 * then `Bridged` — so the endowment is one or two events back.
 *
 * Dropping the imbalance takes the POLYX from the block reward reserve while that has free
 * balance, and mints the rest, with no event either way (see `reserveShare`).
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

  const endowed = findBlockEntries(args.blockId, recipient, amount, [MovementKind.Endowment]).find(
    entry => recentEventIds(args).has(entry.movementId)
  );

  // Funded from the block reward reserve first (see `reserveShare`).
  if (endowed) {
    await drawReserveFor(args, endowed, MovementKind.Mint);
    return;
  }

  await creditFromReserve(args, recipient, amount, MovementKind.Mint);
};

// Fees — the treasury's cut and the block author's

/**
 * The treasury's cut of a fee, announced by the event at `index` — `0` when that event is not one.
 *
 * Up to v5.4.0 the runtime split every fee rather than paying it all to the block author: 80% went
 * to the treasury, which announced it as `treasury.TreasuryReimbursement`, and the remaining 20% to
 * the author, unannounced. The treasury's event sits at a fixed point beside the fee it came from —
 * right after a protocol fee's `FeeCharged`, and right before a transaction fee is settled (its
 * `TransactionFeePaid` from v5.4.0, or the extrinsic's closing event before it) — so its position
 * says which fee it is a cut of. From v5.4.2 fees go to the author whole and no such event appears.
 * `feeIndex` is the fee's own event; the cut is in its phase, which is the block's initialisation
 * for a fee charged outside any extrinsic.
 */
export const treasuryShareAt = (block: SubstrateBlock, index: number, feeIndex: number): bigint => {
  const records = block.events ?? [];
  const record = records[index];

  // the same phase as the fee: its extrinsic, or a fee charged as the block initialises
  if (
    record?.event.section !== 'treasury' ||
    record.event.method !== 'TreasuryReimbursement' ||
    record.phase.toString() !== records[feeIndex]?.phase.toString()
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

// PIPs deposits — a lock with no balance event

const ensureBalanceRow = async (
  address: string,
  blockId: string,
  datetime: Date,
  blockEventId: string
): Promise<void> => {
  await ledgerAccount(address, blockId, datetime);
  const balance = await loadBalance(address, undefined, blockEventId);
  await balance.save();
};

/**
 * Sets `address`'s `'pips    '` lock to what the chain holds after this block.
 *
 * The pips pallet locks proposal and vote deposits with `Currency::increase_lock` /
 * `reduce_lock(PIPS_LOCK_ID, …)`, and the pre-v8 balances pallet emits nothing for a lock change.
 * The lock is an aggregate over every PIP the account has a deposit on, so it is read back rather
 * than accumulated from the event amounts.
 *
 * v8 is skipped: upstream `update_locks` emits `Locked`/`Unlocked` for the change in `frozen`,
 * which `handleBalanceLocked`/`handleBalanceUnlocked` already record.
 */
const syncPipsLock = async (address: string, args: HandlerArgs): Promise<void> => {
  const amount = await readOrAnomaly(args, `the pips lock of ${address} was left as it was`, () =>
    readChainLock(address, PIPS_LOCK_ID)
  );

  if (amount === undefined) {
    return;
  }

  await ensureBalanceRow(address, args.blockId, args.block.timestamp, args.blockEventId);
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

  const addresses = new Set<string>(votes.map(vote => vote.accountId));

  if (proposal?.proposer.type === 'Community') {
    addresses.add(proposal.proposer.value);
  }

  // One at a time, so each account's ledger entries are added in the same order on every run.
  await [...addresses].reduce(
    (previous, address) => previous.then(() => syncPipsLock(address, args)),
    Promise.resolve()
  );
};
