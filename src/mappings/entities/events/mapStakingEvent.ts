import { hexAddPrefix } from '@polkadot/util';
import { SubstrateEvent } from '@subql/types';
import { EventIdEnum, StakingEvent } from '../../../types';
import { getBigIntValue, getTextValue } from '../../../utils';
import { extract8xStakingAmount, is8xChain } from '../../../utils/common';
import { extractArgs } from '../common';

const bondedUnbondedOrReward = new Set([
  EventIdEnum.Bonded,
  EventIdEnum.Unbonded,
  EventIdEnum.Reward,
  EventIdEnum.Rewarded, // from 7.x Reward was renamed to Rewarded
]);

/**
 * Subscribes to staking events
 */
export async function handleStakingEvent(event: SubstrateEvent): Promise<void> {
  const { eventId, params, extrinsic, blockId, blockEventId, block } = extractArgs(event);
  let amount: bigint;
  let stashAccount: string;
  let nominatedValidators: string[];
  let identityId: string;

  if ([EventIdEnum.Slash, EventIdEnum.Slashed].includes(eventId)) {
    const [rawAccount, rawAmount] = params;

    stashAccount = getTextValue(rawAccount);
    amount = getBigIntValue(rawAmount);
  } else if (is8xChain(block)) {
    // On 8.x chain, staking events don't have DID as first param
    // Bonded/Unbonded: [stash, amount] - 2 params
    // Rewarded: [stash, dest, amount] - 3 params (dest is RewardDestination enum)
    const [rawAccount, rawDest, rawAmount] = params;
    stashAccount = getTextValue(rawAccount);

    if (bondedUnbondedOrReward.has(eventId)) {
      amount = extract8xStakingAmount(rawDest, rawAmount);
    } else if (eventId === EventIdEnum.Nominated) {
      nominatedValidators = rawAmount.toJSON() as string[];
    }
  } else {
    const [rawDid, rawAccount] = params;

    identityId = getTextValue(rawDid);
    stashAccount = getTextValue(rawAccount);

    if (bondedUnbondedOrReward.has(eventId)) {
      amount = getBigIntValue(params[2]);
    } else if (eventId === EventIdEnum.Nominated) {
      nominatedValidators = params[2].toJSON() as string[];
    }
  }

  let transactionId;
  if (extrinsic) {
    transactionId = hexAddPrefix(extrinsic.extrinsic.hash.toJSON());
  }

  await StakingEvent.create({
    id: blockEventId,
    eventId,
    identityId,
    stashAccount,
    amount,
    nominatedValidators,
    transactionId,
    datetime: block.timestamp,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
}
