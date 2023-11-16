import { hexAddPrefix } from '@polkadot/util';
import { ModuleIdEnum, StakingEvent } from '../../types';
import { getBigIntValue, getTextValue } from '../util';
import { HandlerArgs } from './common';

enum StakingEventType {
  Bonded = 'Bonded',
  Unbonded = 'Unbonded',
  Nominated = 'Nominated',
  Reward = 'Reward',
  Slash = 'Slash',
}
const stakingEventTypes = new Set<string>(Object.values(StakingEventType));
const isStakingEventType = (e: string): e is StakingEventType => stakingEventTypes.has(e);

const bondedUnbondedOrReward = new Set([
  StakingEventType.Bonded,
  StakingEventType.Unbonded,
  StakingEventType.Reward,
]);

/**
 * Subscribes to staking events
 */
export async function mapStakingEvent({
  blockId,
  eventId,
  moduleId,
  params,
  eventIdx,
  block,
  extrinsic,
}: HandlerArgs): Promise<void> {
  if (moduleId === ModuleIdEnum.staking && isStakingEventType(eventId)) {
    let amount: bigint;
    let stashAccount: string;
    let nominatedValidators: string[];
    let identityId: string;

    if (eventId === StakingEventType.Slash) {
      const [rawAccount, rawAmount] = params;

      stashAccount = getTextValue(rawAccount);
      amount = getBigIntValue(rawAmount);
    } else {
      const [rawDid, rawAccount] = params;

      identityId = getTextValue(rawDid);
      stashAccount = getTextValue(rawAccount);

      if (bondedUnbondedOrReward.has(eventId)) {
        amount = getBigIntValue(params[2]);
      } else if (eventId === StakingEventType.Nominated) {
        nominatedValidators = params[2].toJSON() as string[];
      }
    }

    let transactionId;
    if (extrinsic) {
      transactionId = hexAddPrefix(extrinsic.extrinsic.hash.toJSON());
    }

    await StakingEvent.create({
      id: `${blockId}/${eventIdx}`,
      eventId,
      identityId,
      stashAccount,
      amount,
      nominatedValidators,
      transactionId,
      datetime: block.timestamp,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  }
}
