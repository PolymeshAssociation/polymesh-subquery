import { hexAddPrefix } from '@polkadot/util';
import { EventRecord } from '@polkadot/types/interfaces';
import { Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { decodeEvent, DecodedEvent, optionalField } from '../../../decode';
import {
  Account,
  AnomalyKind,
  EventIdEnum,
  HoldReason,
  StakingEvent,
  StakingPosition,
} from '../../../types';
import { getBigIntValue, getTextValue } from '../../../utils';
import { recordAnomaly } from '../../../utils/anomaly';
import { blockEvents, substrateEventAt } from '../../../utils/blockEvents';
import { is8xChain } from '../../../utils/common';
import {
  readRewardDestination,
  resolveLegacyRewardDestination,
  RewardDestinationName,
} from '../../../utils/staking';
import { extractArgs } from '../common';
import { holdReasonFromJson } from '../identities/ledgerCore';
import { currentPayoutEra, currentPayoutValidator } from '../identities/mapPolyxLedger';
import { refreshPositionFromLedger } from './mapStakingPosition';

const bondedUnbondedOrReward = new Set([
  EventIdEnum.Bonded,
  EventIdEnum.Unbonded,
  EventIdEnum.Reward,
  EventIdEnum.Rewarded, // from 7.x Reward was renamed to Rewarded
]);

const rewardEvents = new Set([EventIdEnum.Reward, EventIdEnum.Rewarded]);
const slashEvents = new Set([EventIdEnum.Slash, EventIdEnum.Slashed]);

type StakingEventDetails = {
  amount?: bigint;
  stashAccount?: string;
  nominatedValidators?: string[];
  identityId?: string;
  rewardDestination?: RewardDestinationName;
  rewardDestinationAccount?: string;
};

export const getRewardDestinationAccount = (
  destination: RewardDestinationName,
  account?: string,
  stashAccount?: string
): string | undefined => {
  if (destination === 'Account') {
    return account;
  }

  if (destination === 'Staked' || destination === 'Stash') {
    return stashAccount;
  }

  return undefined;
};

const getSlashEventDetails = (params: Codec[]): StakingEventDetails => {
  const [rawAccount, rawAmount] = params;

  return {
    stashAccount: getTextValue(rawAccount),
    amount: getBigIntValue(rawAmount),
  };
};

const getNominatedEventDetails = (params: Codec[]): StakingEventDetails => {
  const [rawDid, rawAccount, rawTargets] = params;

  return {
    identityId: getTextValue(rawDid),
    stashAccount: getTextValue(rawAccount),
    nominatedValidators: rawTargets.toJSON() as string[],
  };
};

/**
 * `handleStakingEvent` is only registered for `Bonded`, `Unbonded`, `Reward`/`Rewarded` on the
 * v8+ path (`Nominated`, `Slash`/`Slashed` are intercepted earlier in `getStakingEventDetails`).
 * An event this switch doesn't know is recorded as an anomaly instead of an incomplete row.
 */
const get8xStakingEventDetails = async (
  eventId: EventIdEnum,
  decoded: DecodedEvent,
  block: SubstrateBlock,
  eventIdx: number,
  blockId: string
): Promise<StakingEventDetails> => {
  // `decoded` throws `FieldNotFound` on any key it doesn't carry (the whole point of the decode
  // layer's guard), so `.stash` is read inside each case that actually has one — not once up
  // front — or a future event without a `stash` field (e.g. `EraPaid`) would crash here instead
  // of reaching the `default` branch's anomaly recording below.
  switch (eventId) {
    case EventIdEnum.Rewarded: {
      const stashAccount = getTextValue(decoded.stash);

      /**
       * Read as optional, and resolved from chain storage when absent: Polymesh's `Rewarded` keeps
       * its own `(identity, stash, amount)` shape, without upstream Substrate's `dest`, and a block
       * near an upgrade can be decoded with the later runtime's shapes.
       */
      const dest = optionalField(decoded, 'dest');

      if (!dest) {
        const resolved = await resolveLegacyRewardDestination(
          stashAccount,
          blockId,
          block,
          eventIdx
        );

        return {
          stashAccount,
          amount: getBigIntValue(decoded.amount),
          rewardDestination: resolved.rewardDestination,
          rewardDestinationAccount: resolved.rewardDestinationAccount,
        };
      }

      const { destination, account } = readRewardDestination(dest.toJSON());

      return {
        stashAccount,
        amount: getBigIntValue(decoded.amount),
        rewardDestination: destination,
        rewardDestinationAccount: getRewardDestinationAccount(destination, account, stashAccount),
      };
    }
    case EventIdEnum.Bonded:
    case EventIdEnum.Unbonded:
      return { stashAccount: getTextValue(decoded.stash), amount: getBigIntValue(decoded.amount) };
    default: {
      // an unknown v8 staking event: recorded instead of guessed at
      void recordAnomaly({
        kind: AnomalyKind.UnknownEnumValue,
        detail: `get8xStakingEventDetails has no case for staking.${eventId}`,
        block,
        eventIdx,
        eventId,
      });

      return { stashAccount: 'stash' in decoded ? getTextValue(decoded.stash) : undefined };
    }
  }
};

const ZERO_DID = /^0x0+$/;

/** `ApplyExtrinsic(n)` keyed by its index; `Initialization` and `Finalization` by name. */
const phaseKey = (phase: any): string | undefined =>
  phase?.isApplyExtrinsic ? `extrinsic ${phase.asApplyExtrinsic.toNumber()}` : phase?.type;

/**
 * Whether the `Unbonded` at `event` was written by `validate_cdd_expiry_nominators` for `stash`.
 *
 * That call unbonds each expired nominator, then emits one `InvalidatedNominators` listing them,
 * all within one phase of the block. The `Unbonded` carries the DID of whoever made the call, not
 * the stash's, so an identity read from it would be the wrong one. The scan is bounded by the
 * phase rather than an extrinsic index because before 6.3.0 the call can run outside one (a
 * scheduled enactment runs in `Initialization`), and it stops at the first record of another phase.
 */
const isCddExpiryUnbond = (event: SubstrateEvent, stash: string): boolean => {
  const records = blockEvents(event.block);
  const ownPhase = phaseKey(records[event.idx]?.phase);

  if (ownPhase === undefined) {
    return false;
  }

  for (let index = event.idx + 1; index < records.length; index += 1) {
    if (phaseKey(records[index].phase) !== ownPhase) {
      return false;
    }

    if (isInvalidatedNominators(records[index])) {
      const { expiredNominators } = decodeEvent(substrateEventAt(event.block, index));

      if (((expiredNominators?.toJSON() as string[] | null) ?? []).includes(stash)) {
        return true;
      }
    }
  }

  return false;
};

const isInvalidatedNominators = ({ event }: EventRecord): boolean =>
  event.section === 'staking' && event.method === 'InvalidatedNominators';

/**
 * `Unbonded` and `Bonded` carry the DID of the extrinsic's caller. For a CDD-expiry unbond that is
 * not the stash's identity: the call is root-only, so from 6.3.0 the DID is the zero DID, and
 * before that the DID of whoever sent the root call. Both fall back to the stash's own identity.
 */
const getLegacyStakingEventDetails = async (
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent,
  block: SubstrateBlock,
  blockId: string,
  eventIdx: number
): Promise<StakingEventDetails> => {
  const [rawDid, rawAccount] = params;
  const stashAccount = getTextValue(rawAccount);
  const did = getTextValue(rawDid);
  const callersDidIsNotTheStashs =
    !did ||
    ZERO_DID.test(did) ||
    (eventId === EventIdEnum.Unbonded && !!stashAccount && isCddExpiryUnbond(event, stashAccount));
  const details: StakingEventDetails = {
    identityId: callersDidIsNotTheStashs ? undefined : did,
    stashAccount,
  };

  if (bondedUnbondedOrReward.has(eventId)) {
    details.amount = getBigIntValue(params[2]);

    if ((eventId === EventIdEnum.Reward || eventId === EventIdEnum.Rewarded) && stashAccount) {
      // The pre-v8 event names only the stash; read the payee from chain storage.
      const resolved = await resolveLegacyRewardDestination(stashAccount, blockId, block, eventIdx);
      details.rewardDestination = resolved.rewardDestination;
      details.rewardDestinationAccount = resolved.rewardDestinationAccount;
    }
  }

  return details;
};

/**
 * `SlashReported` is a validator-offence *report* — a possible future slash, not the movement
 * itself (`Slash`/`Slashed` cover that, handled above). No entity field for it yet, so it's logged
 * the same way `Slash`/`Slashed` are: a `StakingEvent` row naming the validator. Shape-identical
 * pre/post v8, so one `decodeEvent` call covers both eras.
 */
const getSlashReportedDetails = (decoded: DecodedEvent): StakingEventDetails => ({
  stashAccount: getTextValue(decoded.validator),
});

const getStakingEventDetails = async (
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent,
  block: SubstrateBlock,
  eventIdx: number,
  blockId: string
): Promise<StakingEventDetails> => {
  let details: StakingEventDetails;

  if ([EventIdEnum.Slash, EventIdEnum.Slashed].includes(eventId)) {
    details = getSlashEventDetails(params);
  } else if (eventId === EventIdEnum.SlashReported) {
    details = getSlashReportedDetails(decodeEvent(event));
  } else if (eventId === EventIdEnum.Nominated) {
    details = getNominatedEventDetails(params);
  } else if (is8xChain(block)) {
    // Decoded here rather than at the top of `handleStakingEvent`: `decodeEvent` throws for an
    // event with no registered shape, and not every eventId reaching this branch needs one.
    details = await get8xStakingEventDetails(eventId, decodeEvent(event), block, eventIdx, blockId);
  } else {
    details = await getLegacyStakingEventDetails(eventId, params, event, block, blockId, eventIdx);
  }

  if (details.stashAccount && !details.identityId) {
    details.identityId = (await Account.get(details.stashAccount))?.identityId;
  }

  return details;
};

/**
 * Whether v8 really compounded the `Staked` reward `event` reports for `stash`.
 *
 * `make_payout` mints the reward, then writes the ledger, whose hold emits `balances.Held` with
 * reason `Staking` for the stash, then emits `Rewarded`. It ignores a failed ledger write, which is
 * what a stash whose currency hadn't yet migrated to holds gets: its `Rewarded` still says `Staked`,
 * but the reward stays free and `active` doesn't move.
 */
const heldForStaking = (event: SubstrateEvent, stash: string): boolean => {
  const records = event.block.events ?? [];

  for (let index = event.idx - 1; index >= 0; index -= 1) {
    const { section, method, data } = records[index].event;

    // the previous reward, or the start of this payout: this reward's own events are all after it
    if (section === 'staking') {
      return false;
    }

    if (
      section === 'balances' &&
      method === 'Held' &&
      data[1]?.toString() === stash &&
      holdReasonFromJson(data[0]?.toJSON()) === HoldReason.Staking
    ) {
      return true;
    }
  }

  return false;
};

const applyToPosition = async (
  position: StakingPosition,
  eventId: EventIdEnum,
  details: StakingEventDetails,
  stashAccount: string,
  amount: bigint,
  event: SubstrateEvent
): Promise<void> => {
  const { blockEventId } = extractArgs(event);

  if (rewardEvents.has(eventId)) {
    position.totalRewarded += amount;
    if (details.rewardDestination !== undefined) {
      position.rewardDestination = details.rewardDestination;
    }
    if (details.rewardDestinationAccount !== undefined) {
      position.rewardDestinationAccountId = details.rewardDestinationAccount;
    }

    // A `Staked` payee compounds straight into `staking.ledger`: `make_payout` does
    // `active += amount; total += amount` and nothing else to it, in every runtime, so the bond
    // grows by the reward with no ledger read. Other destinations pay out to a free balance and
    // leave the ledger alone.
    if (
      details.rewardDestination === 'Staked' &&
      (!is8xChain(event.block) || heldForStaking(event, stashAccount))
    ) {
      position.bonded += amount;
    }
  } else if (slashEvents.has(eventId)) {
    position.totalSlashed += amount;

    // `do_slash` calls `ledger.slash(...)` and `ledger.update()`, emitting only `Slashed`.
    await refreshPositionFromLedger(position, stashAccount, event);
  } else {
    return;
  }

  position.updatedEventId = blockEventId;
  await position.save();
};

/**
 * Subscribes to staking events
 */
export async function handleStakingEvent(event: SubstrateEvent): Promise<void> {
  const { eventId, params, extrinsic, blockId, blockEventId, block, eventIdx } = extractArgs(event);
  const details = await getStakingEventDetails(
    eventId,
    params as Codec[],
    event,
    block,
    eventIdx,
    blockId
  );

  let transactionId;
  if (extrinsic) {
    transactionId = hexAddPrefix(extrinsic.extrinsic.hash.toJSON());
  }

  const position = details.stashAccount
    ? await StakingPosition.get(details.stashAccount)
    : undefined;

  if (position && details.stashAccount && details.amount !== undefined) {
    await applyToPosition(position, eventId, details, details.stashAccount, details.amount, event);
  }

  const { stashAccount, rewardDestinationAccount, ...rest } = details;

  await StakingEvent.create({
    id: blockEventId,
    eventId,
    ...rest,
    stashId: stashAccount,
    rewardDestinationAccountId: rewardDestinationAccount,
    transactionId,
    eraIndex: currentPayoutEra(blockId),
    validatorId: rewardEvents.has(eventId) ? currentPayoutValidator(blockId) : undefined,
    positionId: position?.id,
    createdEventId: blockEventId,
  }).save();
}
