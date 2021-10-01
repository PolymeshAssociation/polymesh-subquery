import { Codec } from "@polkadot/types/types";
import { SubstrateEvent } from "@subql/types";
import { StakingEvent } from "../../types";
import { EventIdEnum, ModuleIdEnum } from "./common";

enum StakingEventType {
  Bonded = "Bonded",
  Unbonded = "Unbonded",
  Nominated = "Nominated",
  Reward = "Reward",
  Slash = "Slash",
}
const stakingEventTypes = new Set<string>(Object.values(StakingEventType));
const isStakingEventType = (e: string): e is StakingEventType =>
  stakingEventTypes.has(e);

const bondedUnbondedOrReward = new Set([
  StakingEventType.Bonded,
  StakingEventType.Unbonded,
  StakingEventType.Reward,
]);
/**
 * Subscribes to events related to staking events
 */
export async function mapStakingEvent(
  blockId: number,
  eventId: EventIdEnum,
  moduleId: string,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> {
  if (moduleId === ModuleIdEnum.Staking && isStakingEventType(eventId)) {
    await StakingEvent.create({
      id: `${blockId}/${event.idx}`,
      blockId,
      eventIdx: event.idx,
      stakingEventId: event.event.method,
      date: event.block.timestamp,
      identityId:
        eventId === StakingEventType.Slash ? null : params[0].toJSON(),
      stashAccount:
        eventId === StakingEventType.Slash
          ? params[0].toJSON()
          : params[1].toJSON(),
      amount:
        eventId === StakingEventType.Slash
          ? params[1].toJSON()
          : bondedUnbondedOrReward.has(eventId)
          ? params[2].toJSON()
          : null,
      nominatedValidators: eventId === "Nominated" ? params[2].toJSON() : null,
    }).save();
  }
}
