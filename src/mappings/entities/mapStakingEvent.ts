import { hexAddPrefix } from '@polkadot/util';
import { ModuleIdEnum, StakingEvent } from '../../types';
import { getBigIntValue, getTextValue, serializeAccount } from '../util';
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
  event,
}: HandlerArgs): Promise<void> {
  if (moduleId === ModuleIdEnum.staking && isStakingEventType(eventId)) {
    let amount: bigint;
    let stashAccount: string;
    let nominatedValidators: string[];
    let identityId: string;

    if (eventId === StakingEventType.Slash) {
      const [rawAccount, rawAmount] = params;

      stashAccount = serializeAccount(rawAccount);
      amount = getBigIntValue(rawAmount);
    } else {
      const [rawDid, rawAccount] = params;

      identityId = getTextValue(rawDid);
      stashAccount = serializeAccount(rawAccount);

      if (bondedUnbondedOrReward.has(eventId)) {
        amount = getBigIntValue(params[2]);
      } else if (eventId === StakingEventType.Nominated) {
        nominatedValidators = params[2].toJSON() as string[];
      }
    }

    await StakingEvent.create({
      id: `${blockId}/${event.idx}`,
      eventId,
      identityId,
      stashAccount,
      amount,
      nominatedValidators,
      transactionId: hexAddPrefix(event.extrinsic?.extrinsic.hash.toJSON()),
      datetime: event.block.timestamp,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  }
}
