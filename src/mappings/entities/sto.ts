import { Codec } from "@polkadot/types/types";
import { Sto } from "../../types";
import { serializeTicker } from "../util";
import { EventIdEnum, ModuleIdEnum } from "./common";

export async function handleSto(
  event_id: string,
  module_id: string,
  params: Codec[]
): Promise<void> {
  if (
    module_id === ModuleIdEnum.Sto &&
    event_id === EventIdEnum.FundraiserCreated
  ) {
    const offering_asset =
      params[3] instanceof Map ? params[3].get("offering_asset") : undefined;
    if (!offering_asset) {
      throw new Error("Couldn't find offering_asset for sto");
    }
    await Sto.create({
      id: params[1].toString(),
      offering_asset: serializeTicker(offering_asset),
    }).save();
  }
}
