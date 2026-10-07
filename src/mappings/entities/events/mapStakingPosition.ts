import { SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { StakingPosition } from '../../../types';
import { blockTime, getTextValue } from '../../../utils';
import { ledgerAccount } from '../../../utils/accounts';
import { readStakingLedger, resolveController } from '../../../utils/staking';
import { ensureTrueSpecVersion } from '../../trueSpec';
import { indexClosingEvent } from '../block/closingEvent';
import { extractArgs } from '../common';

/**
 * Maintains `StakingPosition` — kept separate from the POLYX ledger's `handleBonded`/
 * `handleUnbonded`/`handleWithdrawn`, which fire on the same events but answer a different
 * question (did POLYX move). Registered as an additional handler on the same three events.
 *
 * `bonded`/`unbonding` are read from `staking.ledger`, the same chain read
 * `AccountBalance.bonded`/`.locks`/`.holds` are kept in sync from (`readStakingLedger` in
 * `src/utils/staking.ts`) — a second view onto that number, not an independently accumulated one.
 * Keeping the two in step means re-reading on **every** event that rewrites the ledger, which is
 * more than the three registered here: a compounded reward and a slash both do so silently, and
 * `mapStakingEvent.ts` calls `refreshPositionFromLedger` for those. `rewardDestination`/`rewardDestinationAccount`
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
    const controller = await resolveController(stash, blockId);

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

/**
 * Re-reads `staking.ledger` into `position`, and re-resolves the controller it is keyed by.
 *
 * Exported because the ledger changes on events this module is not registered for: a compounded
 * (`RewardDestination::Staked`) reward and a slash both rewrite it while emitting only
 * `Rewarded`/`Slashed`, so `mapStakingEvent.ts` calls this from those handlers. `controller`
 * is refreshed here rather than only at creation because `set_controller` moves the ledger to a
 * new key and emits nothing — leaving a position permanently naming the old one.
 *
 * The controller is a relation, and `set_controller` can name an account nothing has indexed yet,
 * so its row is ensured before the position is pointed at it — the same as at creation.
 */
export const refreshPositionFromLedger = async (
  position: StakingPosition,
  stash: string,
  event: SubstrateEvent
): Promise<void> => {
  const { blockId, block, blockEventId } = extractArgs(event);
  const controller = await resolveController(stash, blockId);

  if (controller !== position.controllerId) {
    await ledgerAccount(controller, blockId, blockTime(block), blockEventId);
    position.controllerId = controller;
  }

  const snapshot = await readStakingLedger(stash, blockId);

  position.bonded = snapshot.active;
  position.unbonding = snapshot.total - snapshot.active;
  position.unlocking = snapshot.unlocking;
};

export const handlePositionBonded = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block, blockEventId } = extractArgs(event);
  const stash = getTextValue(decodeEvent(event).stash);

  if (!stash) {
    return;
  }

  const position = await getOrCreatePosition(stash, blockId, blockTime(block), blockEventId);

  await refreshPositionFromLedger(position, stash, event);

  position.updatedEventId = blockEventId;

  await position.save();
};

/**
 * `staking.Unbonded` — the unbonding queue keeps the total lock unchanged, only moving the
 * amount from `active` to `unlocking`, which only a chain read distinguishes.
 */
export const handlePositionUnbonded = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block, blockEventId } = extractArgs(event);
  const stash = getTextValue(decodeEvent(event).stash);

  if (!stash) {
    return;
  }

  const position = await getOrCreatePosition(stash, blockId, blockTime(block), blockEventId);

  await refreshPositionFromLedger(position, stash, event);

  position.updatedEventId = blockEventId;

  await position.save();
};

export const handlePositionWithdrawn = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block, blockEventId } = extractArgs(event);
  const stash = getTextValue(decodeEvent(event).stash);

  if (!stash) {
    return;
  }

  const position = await getOrCreatePosition(stash, blockId, blockTime(block), blockEventId);

  await refreshPositionFromLedger(position, stash, event);

  position.updatedEventId = blockEventId;

  await position.save();
};

/**
 * `staking.set_controller` — moves a stash's ledger to a new controller and emits nothing.
 *
 * Every other ledger change carries an event this module re-reads the ledger on, so without this a
 * position kept naming the old controller until something else touched the stash — a bond, an
 * unbond, a reward — which for an idle stash could be never. A call handler, filtered to this one
 * call, reaches it without subscribing to anything that would stop the node skipping empty blocks.
 *
 * A top-level call only: one made inside a batch is not seen here, and is picked up by the next
 * event that re-reads the ledger, as before.
 */
export const handleSetController = async (extrinsic: SubstrateExtrinsic): Promise<void> => {
  // a call can be the first thing the node hands over for a block, ahead of any event
  await ensureTrueSpecVersion(extrinsic.block);

  const stash = extrinsic.extrinsic.signer.toString();
  const position = await StakingPosition.get(stash);

  if (!position) {
    return;
  }

  const closing = await indexClosingEvent(extrinsic);

  if (!closing) {
    return;
  }

  await refreshPositionFromLedger(position, stash, closing);

  position.updatedEventId = extractArgs(closing).blockEventId;

  await position.save();
};
