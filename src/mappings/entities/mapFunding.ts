import { Codec } from "@polkadot/types/types";
import { SubstrateEvent } from "@subql/types";
import { Funding } from "../../types";
import { serializeTicker } from "../util";
import { EventIdEnum, ModuleIdEnum } from "./common";

/**
 * Subscribes to events related to funding events
 */
export async function mapFunding(
  blockId: number,
  eventId: EventIdEnum,
  moduleId: ModuleIdEnum,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> {
  if (moduleId === "asset" && eventId === "Issued") {
    const rawTicker = params[1];
    const ticker = serializeTicker(rawTicker);
    const value = params[3];
    const fundingName = params[4].toString();
    const totalIssuedInFundingRound = params[5];
    await Funding.create({
      id: `${blockId}/${event.idx}`,
      ticker,
      eventIdx: event.idx,
      blockId,
      fundingName,
      value,
      totalIssuedInFundingRound,
    }).save();
  }
}
