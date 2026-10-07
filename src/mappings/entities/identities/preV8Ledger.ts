import { Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import {
  AccountBalance,
  AnomalyKind,
  EventIdEnum,
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
import { recordAnomaly } from '../../../utils/anomaly';
import { is8xChain } from '../../../utils/common';
import { blockAuthor } from '../../../utils/blockAuthor';
import { readStakingLock, resolveLegacyRewardDestination } from '../../../utils/staking';
import { getAccountKey, ledgerAccount } from '../../../utils/accounts';
import { extractArgs, HandlerArgs } from '../common';
import { getAccountId, systematicIssuers } from '../../consts';
import { storageEntriesAtParent, UndecodableStateError } from '../../../utils/storageAtParent';
import {
  findBlockEntries,
  findExtrinsicEntries,
  firstText,
  loadBalance,
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

// ---------------------------------------------------------------------------------------------
// Staking — bonded with a lock
// ---------------------------------------------------------------------------------------------

/**
 * Sets the pre-v8 `'staking '` lock on `stash` to `staking.ledger.total` read from chain.
 *
 * The chain read is authoritative — it already accounts for the max-bond cap, the rounding of a
 * compounded `Staked` reward, unbonding chunks, and slashes.
 */
export const syncStakingLock = async (stash: string, args: HandlerArgs): Promise<void> => {
  const total = await readStakingLock(stash, args.blockId);

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
  blockId: string
): Promise<{ recipient: string; restaked: boolean }> => {
  const { rewardDestination, rewardDestinationAccount } = await resolveLegacyRewardDestination(
    stash,
    blockId
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
 * a `'staking '` lock, so an account that still has one is being migrated, and the lock is cleared
 * rather than the generic `'balances'` one. `false` when `who` has no such lock.
 */
export const clearMigratedStakingLock = async (
  who: string | undefined,
  blockEventId: string
): Promise<boolean> => {
  const locks = who ? (await AccountBalance.get(who))?.locks : undefined;

  if (!who || !locks?.some(lock => lock.lockId === STAKING_LOCK_ID)) {
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
 */
export const syncMigratedStakingLock = async (who: string, blockEventId: string): Promise<void> => {
  const balance = await AccountBalance.get(who);
  const locked = balance?.locks?.some(lock => lock.lockId === STAKING_LOCK_ID);

  if (!locked) {
    return;
  }

  const [listed, frozen] = await Promise.all([readChainStakingLock(who), readChainFrozen(who)]);
  const onChain = (listed ?? BigInt(0)) < frozen ? listed ?? BigInt(0) : frozen;

  await setLock(who, STAKING_LOCK_ID, onChain, blockEventId, 'staking');
};

/** `staking.CurrencyMigrated { stash, force_withdraw }`: v8 has removed the stash's legacy lock. */
export const handleCurrencyMigrated = async (event: SubstrateEvent): Promise<void> => {
  const { blockEventId } = extractArgs(event);
  const stash = stakingStash(decodeEvent(event));

  if (stash) {
    await syncMigratedStakingLock(stash, blockEventId);
  }
};

// ---------------------------------------------------------------------------------------------
// Slashes — the reporters' share
// ---------------------------------------------------------------------------------------------

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
  const entries = await storageEntriesAtParent(block, 'staking', 'unappliedSlashes').catch(
    (error: unknown) => {
      if (error instanceof UndecodableStateError) {
        return undefined;
      }
      throw error;
    }
  );

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
export const creditSlashReporters = async (
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
            source: validator,
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

// ---------------------------------------------------------------------------------------------
// The block reward reserve — what funded a deposit
// ---------------------------------------------------------------------------------------------

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
 * On testnet the reserve held 1 POLYX and paid the first reward of block 9,259,823; on mainnet it
 * held real funds and paid rewards for a long time, and every one was recorded as newly minted.
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

// ---------------------------------------------------------------------------------------------
// Deposits with no balance event
// ---------------------------------------------------------------------------------------------

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
  // Not in the v8 type augmentation (the storage was dropped with child identities there).
  const identity = (
    api.query as unknown as Record<
      string,
      { parentDid?: (id: string) => Promise<{ isSome?: boolean }> } | undefined
    >
  ).identity;

  return (await identity?.parentDid?.(did))?.isSome === true;
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

// ---------------------------------------------------------------------------------------------
// Fees — the treasury's cut and the block author's
// ---------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------
// PIPs deposits — a lock with no balance event
// ---------------------------------------------------------------------------------------------

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

  // `ProposalVote.account` is the raw public key; balances are keyed by SS58 address.
  const addresses = new Set<string>(
    votes.map(vote => getAccountKey(vote.account, api.registry.chainSS58))
  );

  if (proposal?.proposer.type === 'Community') {
    addresses.add(proposal.proposer.value);
  }

  await Promise.all([...addresses].map(address => syncPipsLock(address, args)));
};
