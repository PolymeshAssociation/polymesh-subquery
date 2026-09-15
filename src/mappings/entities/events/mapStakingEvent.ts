import { hexAddPrefix } from '@polkadot/util';
import { Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { decodeEvent, DecodedEvent } from '../../../decode';
import { Account, AnomalyKind, EventIdEnum, StakingEvent } from '../../../types';
import { getBigIntValue, getTextValue } from '../../../utils';
import { recordAnomaly } from '../../../utils/anomaly';
import { is8xChain } from '../../../utils/common';
import {
  readRewardDestination,
  resolveLegacyRewardDestination,
  RewardDestinationName,
} from '../../../utils/staking';
import { extractArgs } from '../common';

const bondedUnbondedOrReward = new Set([
  EventIdEnum.Bonded,
  EventIdEnum.Unbonded,
  EventIdEnum.Reward,
  EventIdEnum.Rewarded, // from 7.x Reward was renamed to Rewarded
]);

type StakingEventDetails = {
  amount?: bigint;
  stashAccount?: string;
  nominatedValidators?: string[];
  identityId?: string;
  rewardDestination?: RewardDestinationName;
  rewardDestinationAccount?: string;
};

const getRewardDestinationAccount = (
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
const get8xStakingEventDetails = (
  eventId: EventIdEnum,
  decoded: DecodedEvent,
  block: SubstrateBlock,
  eventIdx: number
): StakingEventDetails => {
  // `decoded` throws `FieldNotFound` on any key it doesn't carry (the whole point of the decode
  // layer's guard), so `.stash` is read inside each case that actually has one — not once up
  // front — or a future event without a `stash` field (e.g. `EraPaid`) would crash here instead
  // of reaching the `default` branch's anomaly recording below.
  switch (eventId) {
    case EventIdEnum.Rewarded: {
      const stashAccount = getTextValue(decoded.stash);
      const { destination, account } = readRewardDestination(decoded.dest.toJSON());

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

const getLegacyStakingEventDetails = async (
  eventId: EventIdEnum,
  params: Codec[]
): Promise<StakingEventDetails> => {
  const [rawDid, rawAccount] = params;
  const stashAccount = getTextValue(rawAccount);
  const details: StakingEventDetails = {
    identityId: getTextValue(rawDid),
    stashAccount,
  };

  if (bondedUnbondedOrReward.has(eventId)) {
    details.amount = getBigIntValue(params[2]);

    if ((eventId === EventIdEnum.Reward || eventId === EventIdEnum.Rewarded) && stashAccount) {
      // A15 — the pre-v8 event names only the stash; read the payee from chain storage.
      const resolved = await resolveLegacyRewardDestination(stashAccount);
      details.rewardDestination = resolved.rewardDestination;
      details.rewardDestinationAccount = resolved.rewardDestinationAccount;
    }
  }

  return details;
};

const getStakingEventDetails = async (
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent,
  block: SubstrateBlock,
  eventIdx: number
): Promise<StakingEventDetails> => {
  let details: StakingEventDetails;

  if ([EventIdEnum.Slash, EventIdEnum.Slashed].includes(eventId)) {
    details = getSlashEventDetails(params);
  } else if (eventId === EventIdEnum.Nominated) {
    details = getNominatedEventDetails(params);
  } else if (is8xChain(block)) {
    // Decoded lazily, here rather than at the top of `handleStakingEvent`: some eventIds reaching
    // this branch (historically `Nominated`, before its shape was registered) had no decoder for
    // their pre-v8 tuple form, and `decodeEvent` throws `NoDecoderForSpecVersion` rather than
    // returning nothing — calling it unconditionally for every staking event would risk breaking
    // one on the way to a branch that never uses the result.
    details = get8xStakingEventDetails(eventId, decodeEvent(event), block, eventIdx);
  } else {
    details = await getLegacyStakingEventDetails(eventId, params);
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
  const { eventId, params, extrinsic, blockEventId, block, eventIdx } = extractArgs(event);
  const details = await getStakingEventDetails(eventId, params as Codec[], event, block, eventIdx);

  let transactionId;
  if (extrinsic) {
    transactionId = hexAddPrefix(extrinsic.extrinsic.hash.toJSON());
  }

  await StakingEvent.create({
    id: blockEventId,
    eventId,
    ...details,
    transactionId,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();
}
