import { Codec } from "@polkadot/types/types";
import { Authorization } from "../../types";
import {
  getFirstKeyFromJson,
  getFirstValueFromJson,
  getTextValue,
} from "../util";
import { EventIdEnum, ModuleIdEnum } from "./common";

enum AuthorizationEventType {
  AuthorizationAdded = "AuthorizationAdded",
  AuthorizationRevoked = "AuthorizationRevoked",
  AuthorizationRejected = "AuthorizationRejected",
  AuthorizationConsumed = "AuthorizationConsumed",
}

enum AuthorizationStatus {
  Pending = "Pending",
  Consumed = "Consumed",
  Rejected = "Rejected",
  Revoked = "Revoked",
  Expired = "Expired",
}

const authorizationEventTypes = new Set<string>(
  Object.values(AuthorizationEventType)
);

const isAuthorizationEvent = (e: string): e is AuthorizationEventType =>
  authorizationEventTypes.has(e);

const authorizationEventStatusMapping = new Map<
  AuthorizationEventType,
  AuthorizationStatus
>([
  [AuthorizationEventType.AuthorizationConsumed, AuthorizationStatus.Consumed],
  [AuthorizationEventType.AuthorizationRevoked, AuthorizationStatus.Revoked],
  [AuthorizationEventType.AuthorizationRejected, AuthorizationStatus.Rejected],
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
        block_id,
        auth_id: params[2],
        to_key: getTextValue(params[1]),
        status: authorizationEventStatusMapping.get(event_id),
      }).save();
    } else {
      const expiry = getTextValue(params[5]);

      let status = AuthorizationStatus.Expired;
      if (!expiry || +expiry > new Date().getTime()) {
        status = AuthorizationStatus.Pending;
      }

      await Authorization.create({
        id: params[3],
        block_id,
        auth_id: params[3],
        from_did: getTextValue(params[0]),
        to_did: getTextValue(params[1]),
        to_key: getTextValue(params[2]),
        type: getFirstKeyFromJson(params[4]),
        data: getFirstValueFromJson(params[4]),
        expiry,
        status,
      }).save();
    }
  }
}
