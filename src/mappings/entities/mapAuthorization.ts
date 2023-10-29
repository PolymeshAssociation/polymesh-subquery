import {
  Authorization,
  AuthorizationStatusEnum,
  AuthTypeEnum,
  EventIdEnum,
  ModuleIdEnum,
} from '../../types';
import { getFirstKeyFromJson, getFirstValueFromJson, getTextValue } from '../util';
import { capitalizeFirstLetter, getDateValue, serializeAccount } from './../util';
import { HandlerArgs } from './common';
import { createIdentityIfNotExists } from './mapIdentities';

const authorizationEvents = new Set<string>([
  EventIdEnum.AuthorizationAdded,
  EventIdEnum.AuthorizationConsumed,
  EventIdEnum.AuthorizationRejected,
  EventIdEnum.AuthorizationRevoked,
]);

const isAuthorizationEvent = (e: string): e is EventIdEnum => authorizationEvents.has(e);

const authorizationEventStatusMapping = new Map<EventIdEnum, AuthorizationStatusEnum>([
  [EventIdEnum.AuthorizationConsumed, AuthorizationStatusEnum.Consumed],
  [EventIdEnum.AuthorizationRevoked, AuthorizationStatusEnum.Revoked],
  [EventIdEnum.AuthorizationRejected, AuthorizationStatusEnum.Rejected],
]);

export async function mapAuthorization({
  blockId,
  eventId,
  moduleId,
  params,
  eventIdx,
  block,
}: HandlerArgs): Promise<void> {
  if (moduleId === ModuleIdEnum.identity && isAuthorizationEvent(eventId)) {
    if (authorizationEventStatusMapping.has(eventId)) {
      const auth = await Authorization.get(params[2].toString());
      auth.status = authorizationEventStatusMapping.get(eventId);
      auth.updatedBlockId = blockId;

      await auth.save();
    } else {
      const fromId = getTextValue(params[0]);

      // For `identity.cdd_register_did` extrinsic with params including `SecondaryKey` along with `TargetAccount`, `AuthorizationAdded` event is triggered before `DidCreated` event.
      await createIdentityIfNotExists(fromId, blockId, eventId, eventIdx, block);

      await Authorization.create({
        id: getTextValue(params[3]),
        fromId,
        toId: getTextValue(params[1]),
        toKey: serializeAccount(params[2]),
        type: capitalizeFirstLetter(getFirstKeyFromJson(params[4])) as AuthTypeEnum,
        data: JSON.stringify(getFirstValueFromJson(params[4])),
        expiry: getDateValue(params[5]),
        status: AuthorizationStatusEnum.Pending,
        createdBlockId: blockId,
        updatedBlockId: blockId,
      }).save();
    }
  }
}
