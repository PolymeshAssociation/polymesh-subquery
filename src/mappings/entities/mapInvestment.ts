import { Codec } from "@polkadot/types/types";
import { SubstrateEvent } from "@subql/types";
import { getTextValue } from "../util";
import { Investment } from "./../../types/models/Investment";
import { serializeTicker } from "./../util";
import { EventIdEnum, ModuleIdEnum } from "./common";

/**
 * Subscribes to the STO Invested event
 */
export async function mapInvestment(
  block_id: number,
  event_id: EventIdEnum,
  module_id: ModuleIdEnum,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> {
  if (module_id === ModuleIdEnum.Sto && event_id === EventIdEnum.Invested) {
    await Investment.create({
      id: `${block_id}/${event.idx}`,
      block_id,
      investor: getTextValue(params[0]),
      sto_id: params[1],
      offering_token: serializeTicker(params[2]),
      raise_token: serializeTicker(params[3]),
      offering_token_amount: getTextValue(params[4]),
      raise_token_amount: getTextValue(params[5]),
      datetime: event.block.timestamp,
    }).save();
  }
}
