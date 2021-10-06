import { capitalizeFirstLetter } from "./../util";
import { Codec } from "@polkadot/types/types";
import { Authorization } from "../../types";
import {
  getFirstKeyFromJson,
  getFirstValueFromJson,
  getTextValue,
} from "../util";
import { EventIdEnum, ModuleIdEnum } from "./common";

enum AuthorizationStatus {
  Pending = "Pending",
  Consumed = "Consumed",
  Rejected = "Rejected",
  Revoked = "Revoked",
}

const authorizationEvents = new Set<string>([
  EventIdEnum.AuthorizationAdded,
  EventIdEnum.AuthorizationConsumed,
  EventIdEnum.AuthorizationRejected,
  EventIdEnum.AuthorizationRevoked,
]);

const isAuthorizationEvent = (e: string): e is EventIdEnum =>
  authorizationEvents.has(e);

const authorizationEventStatusMapping = new Map<
  EventIdEnum,
  AuthorizationStatus
>([
  [EventIdEnum.AuthorizationConsumed, AuthorizationStatus.Consumed],
  [EventIdEnum.AuthorizationRevoked, AuthorizationStatus.Revoked],
  [EventIdEnum.AuthorizationRejected, AuthorizationStatus.Rejected],
]);

export async function mapAuthorization(
  block_id: number,
  event_id: EventIdEnum,
  module_id: ModuleIdEnum,
  params: Codec[]
): Promise<void> {
  if (module_id === ModuleIdEnum.Identity && isAuthorizationEvent(event_id)) {
    if (authorizationEventStatusMapping.has(event_id)) {
      await Authorization.create({
        id: params[2],
        auth_id: params[2],
        to_key: getTextValue(params[1]),
        status: authorizationEventStatusMapping.get(event_id),
      }).save();
    } else {
      await Authorization.create({
        id: params[3],
        created_block: block_id,
        auth_id: params[3],
        from_did: getTextValue(params[0]),
        to_did: getTextValue(params[1]),
        to_key: getTextValue(params[2]),
        type: capitalizeFirstLetter(getFirstKeyFromJson(params[4])),
        data: getFirstValueFromJson(params[4]),
        expiry: getTextValue(params[5]),
        status: AuthorizationStatus.Pending,
      }).save();
    }
  }
}
