import { Codec } from "@polkadot/types/types";
import { SubstrateEvent } from "@subql/types";
import { StakingEvent } from "../../types";
import { ModuleId } from "./common";

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

export async function handleStakingEvent(
  block_id: number,
  event_id: string,
  module_id: string,
  params: Codec[],
  event: SubstrateEvent
) {
  if (module_id === ModuleId.staking && isStakingEventType(event_id)) {
    await StakingEvent.create({
      id: `${block_id}/${event.idx}`,
      block_id,
      event_idx: event.idx,
      staking_event_id: event.event.method,
      date: event.block.timestamp,
      identity_id:
        event_id === StakingEventType.Slash ? null : params[0].toJSON(),
      stash_account:
        event_id === StakingEventType.Slash
          ? params[0].toJSON()
          : params[1].toJSON(),
      amount:
        event_id === StakingEventType.Slash
          ? params[1].toJSON()
          : bondedUnbondedOrReward.has(event_id)
          ? params[2].toJSON()
          : null,
      nominated_validators:
        event_id === "Nominated" ? params[2].toJSON() : null,
    }).save();
  }
}
