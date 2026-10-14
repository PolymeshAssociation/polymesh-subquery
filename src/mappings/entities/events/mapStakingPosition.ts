import { encodeDerivedAddress } from '@polkadot/util-crypto';
import { SubstrateBlock, SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { MultiSigProposal, StakingPosition } from '../../../types';
import { blockTime, getBigIntValue, getTextValue } from '../../../utils';
import { ledgerAccount } from '../../../utils/accounts';
import { readOrAnomaly } from '../../../utils/anomaly';
import { readStakingLedger, resolveController } from '../../../utils/staking';
import { readStorage } from '../../../utils/storageAtParent';
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

/**
 * A `staking.bonded` that doesn't decode with the block's metadata is recorded as an anomaly
 * against `block`, and the new position takes the stash as its controller until the next refresh.
 * Without a `block` (a seed run) it propagates.
 */
export const getOrCreatePosition = async (
  stash: string,
  blockId: string,
  datetime: Date,
  blockEventId: string,
  block: SubstrateBlock | undefined,
  eventIdx?: number
): Promise<StakingPosition> => {
  let position = await StakingPosition.get(stash);

  if (!position) {
    const account = await ledgerAccount(stash, blockId, datetime);
    const controller = await readOrAnomaly(
      { block, eventIdx },
      `the controller of ${stash} is taken to be the stash`,
      () => resolveController(stash, blockId),
      stash
    );

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
 *
 * A controller or ledger that doesn't decode with the block's metadata is recorded as an anomaly,
 * and the position is left exactly as it was.
 */
export const refreshPositionFromLedger = async (
  position: StakingPosition,
  stash: string,
  event: SubstrateEvent
): Promise<void> => {
  const { blockId, block, blockEventId, eventIdx, moduleId, eventId } = extractArgs(event);
  const read = await readOrAnomaly(
    { block, eventIdx, moduleId, eventId },
    `the staking position of ${stash} was left as it was`,
    async () => ({
      controller: await resolveController(stash, blockId),
      snapshot: await readStakingLedger(stash, blockId),
    })
  );

  if (!read) {
    return;
  }

  const { controller, snapshot } = read;

  if (controller !== position.controllerId) {
    await ledgerAccount(controller, blockId, blockTime(block), blockEventId);
    position.controllerId = controller;
  }

  position.bonded = snapshot.active;
  position.unbonding = snapshot.total - snapshot.active;
  position.unlocking = snapshot.unlocking.map(chunk => ({
    ...chunk,
    amount: chunk.amount.toString(),
  }));
};

export const handlePositionBonded = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block, blockEventId, eventIdx } = extractArgs(event);
  const stash = getTextValue(decodeEvent(event).stash);

  if (!stash) {
    return;
  }

  const position = await getOrCreatePosition(
    stash,
    blockId,
    blockTime(block),
    blockEventId,
    block,
    eventIdx
  );

  await refreshPositionFromLedger(position, stash, event);

  position.updatedEventId = blockEventId;

  await position.save();
};

/**
 * `staking.Unbonded` — the unbonding queue keeps the total lock unchanged, only moving the
 * amount from `active` to `unlocking`, which only a chain read distinguishes.
 */
export const handlePositionUnbonded = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block, blockEventId, eventIdx } = extractArgs(event);
  const stash = getTextValue(decodeEvent(event).stash);

  if (!stash) {
    return;
  }

  const position = await getOrCreatePosition(
    stash,
    blockId,
    blockTime(block),
    blockEventId,
    block,
    eventIdx
  );

  await refreshPositionFromLedger(position, stash, event);

  position.updatedEventId = blockEventId;

  await position.save();
};

export const handlePositionWithdrawn = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block, blockEventId, eventIdx } = extractArgs(event);
  const stash = getTextValue(decodeEvent(event).stash);

  if (!stash) {
    return;
  }

  const position = await getOrCreatePosition(
    stash,
    blockId,
    blockTime(block),
    blockEventId,
    block,
    eventIdx
  );

  await refreshPositionFromLedger(position, stash, event);

  position.updatedEventId = blockEventId;

  await position.save();
};

/** The stash `controller`'s ledger names; `undefined` for none, or, with an anomaly, one that won't decode. */
const readLedgerStash = (
  controller: string,
  block: SubstrateBlock,
  eventIdx?: number
): Promise<{ stash?: string } | null | undefined> =>
  readOrAnomaly(
    { block, eventIdx },
    `the staking position of ${controller} was left as it was`,
    () =>
      readStorage(
        `staking.ledger of ${controller}`,
        async () =>
          (await api.query.staking.ledger(controller)).toJSON() as { stash?: string } | null
      )
  );

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

/** Whether extrinsic `idx` of `block` emitted `staking.Bonded`, which a `rebond` does from v7 */
const emittedBonded = (block: SubstrateBlock, idx: number): boolean =>
  (block.events ?? []).some(
    ({ phase, event }) =>
      phase.isApplyExtrinsic &&
      phase.asApplyExtrinsic.toNumber() === idx &&
      event.section === 'staking' &&
      event.method === 'Bonded'
  );

/**
 * `staking.rebond` — moves unbonding chunks back to `active`, and before v7 emits nothing.
 *
 * Until v7 nothing else re-reads the ledger for it: a restaked reward adds to `bonded` without a
 * read, so the split between `bonded` and `unbonding` stayed wrong until the stash next bonded or
 * unbonded. From v7 the call emits `Bonded`, which `handlePositionBonded` re-reads the ledger on,
 * so a rebond that emitted it is left to that.
 *
 * Signed by the controller, so the stash is the one its ledger names. A top-level call only, like
 * `handleSetController`.
 */
export const handleRebond = async (extrinsic: SubstrateExtrinsic): Promise<void> => {
  await ensureTrueSpecVersion(extrinsic.block);

  if (emittedBonded(extrinsic.block, extrinsic.idx)) {
    return;
  }

  const controller = extrinsic.extrinsic.signer.toString();
  const ledger = await readLedgerStash(controller, extrinsic.block);
  const position = ledger?.stash ? await StakingPosition.get(ledger.stash) : undefined;

  if (!position) {
    return;
  }

  const closing = await indexClosingEvent(extrinsic);

  if (!closing) {
    return;
  }

  await refreshPositionFromLedger(position, position.id, closing);

  position.updatedEventId = extractArgs(closing).blockEventId;

  await position.save();
};

/**
 * `staking.CurrencyMigrated` with a non-zero `force_withdraw`: v8 cut the stash's ledger to what it
 * could hold, emitting nothing else for the position. Often by 1, the amount the chain keeps free.
 */
export const handlePositionCurrencyMigrated = async (event: SubstrateEvent): Promise<void> => {
  const { blockEventId } = extractArgs(event);
  const decoded = decodeEvent(event);
  const stash = getTextValue(decoded.stash);

  if (!stash || !decoded.forceWithdraw || getBigIntValue(decoded.forceWithdraw) === BigInt(0)) {
    return;
  }

  const position = await StakingPosition.get(stash);

  if (!position) {
    return;
  }

  await refreshPositionFromLedger(position, stash, event);

  position.updatedEventId = blockEventId;

  await position.save();
};

interface CallLike {
  section: string;
  method: string;
  args: unknown[];
}

const isCall = (value: unknown): value is CallLike =>
  typeof (value as CallLike)?.section === 'string' &&
  typeof (value as CallLike)?.method === 'string' &&
  Array.isArray((value as CallLike)?.args);

/**
 * The accounts a `staking.set_controller` inside `call` runs as, given the account `origin` the
 * call itself runs as. Batches run their calls as the same account; `utility.as_derivative` runs
 * its call as the account derived from `origin` and the index.
 */
const setControllerCallers = (call: unknown, origin: string): string[] => {
  if (Array.isArray(call)) {
    return call.flatMap(nested => setControllerCallers(nested, origin));
  }
  if (!isCall(call)) {
    return [];
  }
  if (call.section === 'staking' && call.method === 'setController') {
    return [origin];
  }
  if (call.section === 'utility' && call.method === 'asDerivative') {
    const [index, inner] = call.args;

    return setControllerCallers(
      inner,
      encodeDerivedAddress(
        origin,
        Number((index as { toString(): string }).toString()),
        api.registry.chainSS58
      )
    );
  }
  return call.args.flatMap(nested => setControllerCallers(nested, origin));
};

/**
 * Re-reads the staking position `account`'s call could have changed: its own, as a stash, or its
 * stash's, as a controller. Nothing when it has neither.
 */
const refreshPositionOf = async (account: string, event: SubstrateEvent): Promise<void> => {
  let position = await StakingPosition.get(account);

  if (!position) {
    const ledger = await readLedgerStash(account, event.block, event.idx);
    position = ledger?.stash ? await StakingPosition.get(ledger.stash) : undefined;
  }

  if (!position) {
    return;
  }

  await refreshPositionFromLedger(position, position.id, event);

  position.updatedEventId = extractArgs(event).blockEventId;

  await position.save();
};

/**
 * A `utility` batch or `as_derivative` holding a `staking.set_controller`, which emits no event in
 * any runtime and, nested, never reaches `handleSetController`: call handlers only see top-level
 * calls. Mainnet 17,569,814–17,569,830 moved three stashes' controllers this way. A batch's calls
 * run as its signer; an `as_derivative` call runs as the account derived from the signer and the
 * index, so that is the position re-read, however deep the wrappers nest.
 *
 * `relay_tx` and v6's `batch_old` are not subscribed. `relay_tx` (from v5.4) runs the inner call
 * as an account other than the signer, with no derivation to compute; `batch_old` runs it as the
 * signer itself, like the five batch calls, and is left out only because nothing needs it. Neither
 * has a `set_controller` nested in any chain's indexed history. Were one ever to appear, the
 * position check would catch the stale controller.
 */
export const handleBatchedStakingCalls = async (extrinsic: SubstrateExtrinsic): Promise<void> => {
  await ensureTrueSpecVersion(extrinsic.block);

  const accounts = new Set(
    setControllerCallers(extrinsic.extrinsic.method, extrinsic.extrinsic.signer.toString())
  );

  if (!accounts.size) {
    return;
  }

  const closing = await indexClosingEvent(extrinsic);

  if (closing) {
    // One at a time: a stash and its controller can both be listed, and both re-read one position.
    await [...accounts].reduce(
      (previous, account) => previous.then(() => refreshPositionOf(account, closing)),
      Promise.resolve()
    );
  }
};

/**
 * Whether a multisig proposal sets a controller, from its indexed `MultiSigProposal`: each call by
 * module and name, and a nested batch's calls in its `args` text. `undefined` when the index holds
 * no calls for it.
 */
const proposalSetsController = async (
  multisig: string,
  proposalId: string | undefined
): Promise<boolean | undefined> => {
  if (proposalId === undefined) {
    return undefined;
  }
  const proposals = (await MultiSigProposal.get(`${multisig}/${Number(proposalId)}`))?.params
    ?.proposals;
  if (!proposals?.length) {
    return undefined;
  }

  return proposals.some(
    ({ module, call, args }) =>
      (module === 'staking' && call === 'set_controller') ||
      (args.includes('"section":"staking"') && args.includes('"method":"setController"'))
  );
};

/**
 * `multiSig.ProposalExecuted`: the proposal ran as the multisig account. When it made a
 * `set_controller`, which emits no event, the multisig's position is re-read: mainnet
 * 17,569,814–17,569,830 moved three multisig stashes' controllers this way. A proposal the index
 * holds no calls for is re-read to be safe.
 */
export const handlePositionAfterProposal = async (event: SubstrateEvent): Promise<void> => {
  const decoded = decodeEvent(event);
  const multisig = getTextValue(decoded.multisig);

  if (
    multisig &&
    (await proposalSetsController(multisig, getTextValue(decoded.proposalId))) !== false
  ) {
    await refreshPositionOf(multisig, event);
  }
};
