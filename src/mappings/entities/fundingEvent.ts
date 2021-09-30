import { SubstrateEvent } from "@subql/types";
import { FundingEvent } from "../../types";
import { Codec } from "@polkadot/types/types";
import { hexToAscii } from "../util";

export async function handleFundingEvent(
  block_id: number,
  event_id: string,
  module_id: string,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> {
  if (module_id === "asset" && event_id === "Issued") {
    const rawTicker = params[1];
    const ticker = hexToAscii(rawTicker.toString());
    const value = params[3];
    const funding_name = params[4].toString();
    const total_issued_in_funding_round = params[5];
    await FundingEvent.create({
      id: `${block_id}/${event.idx}`,
      ticker,
      event_idx: event.idx,
      block_id,
      funding_name,
      value,
      total_issued_in_funding_round,
    }).save();
  }
}
