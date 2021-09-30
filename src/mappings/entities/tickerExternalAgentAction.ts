import { Codec } from "@polkadot/types/types";
import { SubstrateEvent } from "@subql/types";
import { TickerExternalAgentAction } from "../../types";

export async function handleTickerExternalAgentAction(
  block_id: number,
  event_id: string,
  module_id: string,
  params: Codec[],
  event: SubstrateEvent
) {
  // unimplemented
}
