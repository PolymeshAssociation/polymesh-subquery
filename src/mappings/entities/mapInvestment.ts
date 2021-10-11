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
  blockId: number,
  eventId: EventIdEnum,
  moduleId: ModuleIdEnum,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> {
  if (moduleId === ModuleIdEnum.Sto && eventId === EventIdEnum.Invested) {
    await Investment.create({
      id: `${blockId}/${event.idx}`,
      blockId,
      investor: getTextValue(params[0]),
      stoId: params[1],
      offeringToken: serializeTicker(params[2]),
      raiseToken: serializeTicker(params[3]),
      offeringTokenAmount: getTextValue(params[4]),
      raiseTokenAmount: getTextValue(params[5]),
      datetime: event.block.timestamp,
    }).save();
  }
}
