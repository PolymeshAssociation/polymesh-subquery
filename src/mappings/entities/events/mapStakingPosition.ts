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
 * `src/utils/staking.ts`) — this is a second view onto that number, not an independently
 * accumulated one, so the two cannot drift apart. `rewardDestination`/`rewardDestinationAccount`
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
    const controller = await resolveController(stash).catch(() => stash);

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
 * Applies the current `staking.ledger` snapshot to `position`, or — when the chain read fails —
 * falls back to accumulating the given per-field deltas. Mirrors `syncStakingLock`'s own
 * read-else-accumulate fallback in `mapPolyxLedger.ts`. The fallback is floored at zero: a
 * position created by this very event (no prior `Bonded` seen, e.g. mid-resync) has nothing to
 * subtract from, and a negative `bonded`/`unbonding` is never meaningful.
 */
const applyLedgerOrFallback = async (
  position: StakingPosition,
  stash: string,
  fallback: { bonded?: bigint; unbonding?: bigint }
): Promise<void> => {
  const snapshot = await readStakingLedger(stash);

  if (snapshot) {
    position.bonded = snapshot.active;
    position.unbonding = snapshot.total - snapshot.active;
    position.unlocking = snapshot.unlocking;
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

  await applyLedgerOrFallback(position, stash, { bonded: getBigIntValue(rawAmount) });

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

  await applyLedgerOrFallback(position, stash, { bonded: -amount, unbonding: amount });

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

  await applyLedgerOrFallback(position, stash, { unbonding: -getBigIntValue(rawAmount) });

  position.updatedEventId = blockEventId;

  await position.save();
};
