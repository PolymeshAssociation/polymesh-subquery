import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { StakingPosition } from '../../../types';
import { getBigIntValue, getTextValue } from '../../../utils';
import { ledgerAccount } from '../../../utils/accounts';
import { readStakingLedger, resolveController } from '../../../utils/staking';
import { extractArgs } from '../common';

/**
 * Maintains `StakingPosition` — kept separate from `mapPolyxLedger.ts`'s `handleBonded`/
 * `handleUnbonded`/`handleWithdrawn`, which fire on the same events but answer a different
 * question (did POLYX move). Registered as an additional handler on the same three events.
 *
 * `bonded`/`unbonding` are read from `staking.ledger`, the same chain read
 * `AccountBalance.bonded`/`.locks`/`.holds` are kept in sync from (`readStakingLedger` in
 * `src/utils/staking.ts`) — a second view onto that number, not an independently accumulated one.
 * Keeping the two in step means re-reading on **every** event that rewrites the ledger, which is
 * more than the three registered here: a compounded reward and a slash both do so silently, and
 * `mapStakingEvent.ts` calls `refreshPositionFromLedger` for those (S1). `rewardDestination`/`rewardDestinationAccount`
 * and `totalRewarded`/`totalSlashed` are stamped from `mapStakingEvent.ts`'s `handleStakingEvent`,
 * which already resolves this same `StakingPosition` row to stamp `StakingEvent.position`.
 * `isValidator` is stamped from `mapValidator.ts`. `controller` is resolved here, from the same
 * cached lookup `readStakingLedger` uses internally.
 */

export const getOrCreatePosition = async (
  stash: string,
  blockId: string,
  datetime: Date,
  blockEventId: string
): Promise<StakingPosition> => {
  let position = await StakingPosition.get(stash);

  if (!position) {
    const account = await ledgerAccount(stash, blockId, datetime);
    // `resolveController` has no fallback of its own for an unreadable chain — default to `stash`
    // (the common case, and what `readStakingLedger`'s own fallback path already assumes).
    const controller = await resolveController(stash, blockId).catch(() => stash);

    if (controller !== stash) {
      await ledgerAccount(controller, blockId, datetime);
    }

    position = StakingPosition.create({
      id: stash,
      stashId: stash,
      controllerId: controller,
      identityId: account.identityId,
      bonded: BigInt(0),
      unbonding: BigInt(0),
      isValidator: false,
      isChilled: false,
      totalRewarded: BigInt(0),
      totalSlashed: BigInt(0),
      createdEventId: blockEventId,
      updatedEventId: blockEventId,
    });
  }

  return position;
};

const floorZero = (value: bigint): bigint => (value > BigInt(0) ? value : BigInt(0));

/**
 * Re-reads `staking.ledger` into `position`, and re-resolves the controller it is keyed by.
 *
 * Exported because the ledger changes on events this module is not registered for: a compounded
 * (`RewardDestination::Staked`) reward and a slash both rewrite it while emitting only
 * `Rewarded`/`Slashed`, so `mapStakingEvent.ts` calls this from those handlers (S1). `controller`
 * is refreshed here rather than only at creation because `set_controller` moves the ledger to a
 * new key and emits nothing — leaving a position permanently naming the old one (F6).
 *
 * A failed read leaves `position` untouched: callers either have a delta to fall back on or would
 * rather keep the last known figures than zero them.
 */
export const refreshPositionFromLedger = async (
  position: StakingPosition,
  stash: string,
  blockId: string
): Promise<boolean> => {
  const controller = await resolveController(stash, blockId).catch(() => stash);

  if (controller !== position.controllerId) {
    position.controllerId = controller;
  }

  const snapshot = await readStakingLedger(stash, blockId);

  if (!snapshot) {
    return false;
  }

  position.bonded = snapshot.active;
  position.unbonding = snapshot.total - snapshot.active;
  position.unlocking = snapshot.unlocking;

  return true;
};

/**
 * Applies the current `staking.ledger` snapshot to `position`, or — when the chain read fails —
 * falls back to accumulating the given per-field deltas. Mirrors `syncStakingLock`'s own
 * read-else-accumulate fallback in `mapPolyxLedger.ts`. The fallback is floored at zero: a
 * position created by this very event (no prior `Bonded` seen, e.g. mid-resync) has nothing to
 * subtract from, and a negative `bonded`/`unbonding` is never meaningful.
 */
const applyLedgerOrFallback = async (
  position: StakingPosition,
  stash: string,
  blockId: string,
  fallback: { bonded?: bigint; unbonding?: bigint }
): Promise<void> => {
  if (await refreshPositionFromLedger(position, stash, blockId)) {
    return;
  }

  if (fallback.bonded !== undefined) {
    position.bonded = floorZero(position.bonded + fallback.bonded);
  }
  if (fallback.unbonding !== undefined) {
    position.unbonding = floorZero(position.unbonding + fallback.unbonding);
  }
};

export const handlePositionBonded = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block, blockEventId } = extractArgs(event);
  const { stash: rawStash, amount: rawAmount } = decodeEvent(event);

  const stash = getTextValue(rawStash);

  if (!stash) {
    return;
  }

  const position = await getOrCreatePosition(stash, blockId, block.timestamp, blockEventId);

  await applyLedgerOrFallback(position, stash, blockId, { bonded: getBigIntValue(rawAmount) });

  position.updatedEventId = blockEventId;

  await position.save();
};

/**
 * `staking.Unbonded` — the unbonding queue keeps the total lock unchanged, only moving the
 * amount from `active` to `unlocking` — a chain read distinguishes the two; the fallback delta
 * approximates the same move.
 */
export const handlePositionUnbonded = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block, blockEventId } = extractArgs(event);
  const { stash: rawStash, amount: rawAmount } = decodeEvent(event);

  const stash = getTextValue(rawStash);

  if (!stash) {
    return;
  }

  const position = await getOrCreatePosition(stash, blockId, block.timestamp, blockEventId);
  const amount = getBigIntValue(rawAmount);

  await applyLedgerOrFallback(position, stash, blockId, { bonded: -amount, unbonding: amount });

  position.updatedEventId = blockEventId;

  await position.save();
};

export const handlePositionWithdrawn = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block, blockEventId } = extractArgs(event);
  const { stash: rawStash, amount: rawAmount } = decodeEvent(event);

  const stash = getTextValue(rawStash);

  if (!stash) {
    return;
  }

  const position = await getOrCreatePosition(stash, blockId, block.timestamp, blockEventId);

  await applyLedgerOrFallback(position, stash, blockId, { unbonding: -getBigIntValue(rawAmount) });

  position.updatedEventId = blockEventId;

  await position.save();
};
