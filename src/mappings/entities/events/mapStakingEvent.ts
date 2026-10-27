import { hexAddPrefix } from '@polkadot/util';
import { EventRecord } from '@polkadot/types/interfaces';
import { Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { decodeEvent, DecodedEvent, optionalField } from '../../../decode';
import { Account, AnomalyKind, EventIdEnum, StakingEvent } from '../../../types';
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
import { currentPayoutEra, currentPayoutValidator } from '../identities/mapPolyxLedger';

const bondedUnbondedOrReward = new Set([
  EventIdEnum.Bonded,
  EventIdEnum.Unbonded,
  EventIdEnum.Reward,
  EventIdEnum.Rewarded, // from 7.x Reward was renamed to Rewarded
]);

const rewardEvents = new Set([EventIdEnum.Reward, EventIdEnum.Rewarded]);

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
 * v8+ path (`Nominated`, `Slash`/`Slashed` are intercepted earlier in `getStakingEventDetails`),
 * so every case below is currently reachable — unlike before B3 was fixed, where an eventId
 * outside that set fell through to a bare `{ stashAccount }` with no `amount` and no record of
 * why. Any *future* addition to the `handleStakingEvent` registration for an event this switch
 * doesn't know about now shows up as an anomaly instead of a silently incomplete row.
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
       * Read as optional, and resolved from chain storage when absent.
       *
       * Upstream Substrate's `Rewarded` carries `dest`, but Polymesh keeps its own
       * `(identity, stash, amount)` shape — checked against testnet metadata at spec 8000000 and
       * 7004001, where neither declares a `dest`. Reading it as a required field also made this
       * branch fatal rather than merely wrong: the node can attribute a block near an upgrade to
       * the later runtime, and one pre-v8 reward taken down this path killed the worker and
       * restarted the container mid-resync (block 24,730,189, spec 7004001).
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
      // Defect B3: this used to return `{ stashAccount }` with no explanation for every other
      // v8 staking event, silently dropping `amount`. Recorded instead of guessed at.
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
 * itself (`Slash`/`Slashed` cover that, handled above). No entity field for it yet (per
 * docs/implementation/07-staking.md), so it's logged the same way `Slash`/`Slashed` are: a
 * `StakingEvent` row naming the validator. Shape-identical pre/post v8 (verified against
 * `pallets/staking/src/pallet/mod.rs` at v7.4.0), so one `decodeEvent` call covers both eras.
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
    // Decoded lazily, here rather than at the top of `handleStakingEvent`: some eventIds reaching
    // this branch (historically `Nominated`, before its shape was registered) had no decoder for
    // their pre-v8 tuple form, and `decodeEvent` throws `NoDecoderForSpecVersion` rather than
    // returning nothing — calling it unconditionally for every staking event would risk breaking
    // one on the way to a branch that never uses the result.
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
    createdEventId: blockEventId,
  }).save();
}
