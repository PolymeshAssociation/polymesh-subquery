import { Codec } from "@polkadot/types/types";
import { SubstrateEvent } from "@subql/types";
import { TickerExternalAgentAdded } from "../../types";
import { serializeTicker } from "../util";
import { EventIdEnum, ModuleIdEnum } from "./common";

export async function mapTickerExternalAgentAdded(
  block_id: number,
  event_id: string,
  module_id: string,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> {
  if (
    module_id === ModuleIdEnum.Externalagents &&
    event_id === EventIdEnum.AgentAdded
  ) {
    const caller_did = params[0].toString();
    const ticker = serializeTicker(params[1]);
    await TickerExternalAgentAdded.create({
      id: `${ticker}/${caller_did}`,
      ticker,
      caller_did,
      block_id,
      event_idx: event.idx,
      datetime: event.block.timestamp,
    }).save();
  }
  if (
    module_id === ModuleIdEnum.Externalagents &&
    event_id === EventIdEnum.AgentRemoved
  ) {
    const agent = params[2].toString();
    const ticker = serializeTicker(params[1]);
    await TickerExternalAgentAdded.remove(`${ticker}/${agent}`);
  }
}
