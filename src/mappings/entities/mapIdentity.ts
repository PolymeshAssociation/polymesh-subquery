import { SubstrateEvent } from "@subql/types";
import { Codec } from "@polkadot/types/types";
import { EventIdEnum, ModuleIdEnum } from "./common";
import { Identity } from "../../types";
import { getTextValue } from "../util";
import { Portfolio } from "../../types";

export async function mapIdentity(
  blockId: number,
  eventId: EventIdEnum,
  moduleId: string,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> {
  if (moduleId === ModuleIdEnum.Identity) {
    if (eventId === EventIdEnum.DidCreated) {
      const did = getTextValue(params[0]);
      await Identity.create({
        id: did,
        blockId,
        eventId,
      }).save();

      await Portfolio.create({
        id: `${did}/0`,
        blockId,
        eventId,
        number: 0,
        kind: "Default",
        identityId: did,
      }).save();
    }
  }
}

export async function findOrCreateIdentity(
  did: string,
  blockId: number,
  eventId: EventIdEnum
): Promise<Identity> {
  let identity = await Identity.get(did);
  if (!identity) {
    identity = Identity.create({
      id: did,
      blockId,
      eventId,
    });
    await identity.save();
  }
  return identity;
}
