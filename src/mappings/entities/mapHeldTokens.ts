import { Codec } from "@polkadot/types/types";
import { HeldToken } from "../../types";
import { serializeTicker } from "../util";
import { EventIdEnum, ModuleIdEnum } from "./common";

/**
 * Maps tokens ever held by a DID
 */
export async function mapHeldTokens(
  eventId: EventIdEnum,
  moduleId: ModuleIdEnum,
  params: Codec[]
): Promise<void> {
  if (moduleId !== ModuleIdEnum.Asset) return;

  if (eventId === EventIdEnum.Transfer) {
    const did = params[3].toJSON()["did"];
    const token = serializeTicker(params[1]);

    await HeldToken.create({
      id: `${did}/${token}`,
      did,
      token,
    }).save();
  }

  if (eventId === EventIdEnum.Issued) {
    const token = serializeTicker(params[1]);
    const did = params[2].toJSON()["did"];

    await HeldToken.create({
      id: `${did}/${token}`,
      did,
      token,
    });
  }
}
