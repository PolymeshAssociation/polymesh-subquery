import { hexAddPrefix } from '@polkadot/util';
import { Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { Account, EventIdEnum, StakingEvent } from '../../../types';
import { getBigIntValue, getTextValue } from '../../../utils';
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

const get8xStakingEventDetails = (eventId: EventIdEnum, params: Codec[]): StakingEventDetails => {
  const [rawAccount, rawSecondParam, rawThirdParam] = params;
  const stashAccount = getTextValue(rawAccount);

  if (eventId === EventIdEnum.Rewarded) {
    const { destination, account } = readRewardDestination(rawSecondParam.toJSON());

    return {
      stashAccount,
      amount: getBigIntValue(rawThirdParam),
      rewardDestination: destination,
      rewardDestinationAccount: getRewardDestinationAccount(destination, account, stashAccount),
    };
  }

  if (eventId === EventIdEnum.Bonded || eventId === EventIdEnum.Unbonded) {
    return {
      stashAccount,
      amount: getBigIntValue(rawSecondParam),
    };
  }

  return { stashAccount };
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
  block: SubstrateBlock
): Promise<StakingEventDetails> => {
  let details: StakingEventDetails;

  if ([EventIdEnum.Slash, EventIdEnum.Slashed].includes(eventId)) {
    details = getSlashEventDetails(params);
  } else if (eventId === EventIdEnum.Nominated) {
    details = getNominatedEventDetails(params);
  } else if (is8xChain(block)) {
    details = get8xStakingEventDetails(eventId, params);
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
  const { eventId, params, extrinsic, blockId, blockEventId, block } = extractArgs(event);
  const datetime = block.timestamp as Date;
  const details = await getStakingEventDetails(eventId, params as Codec[], block);

  let transactionId;
  if (extrinsic) {
    transactionId = hexAddPrefix(extrinsic.extrinsic.hash.toJSON());
  }

  await StakingEvent.create({
    id: blockEventId,
    eventId,
    ...details,
    transactionId,
    datetime,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
}
