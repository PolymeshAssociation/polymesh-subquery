import { capitalizeFirstLetter, getDateValue, serializeAccount } from './../util';
import { Codec } from '@polkadot/types/types';
import { Authorization } from '../../types';
import { getFirstKeyFromJson, getFirstValueFromJson, getTextValue } from '../util';
import { EventIdEnum, ModuleIdEnum } from './common';

enum AuthorizationStatus {
  Pending = 'Pending',
  Consumed = 'Consumed',
  Rejected = 'Rejected',
  Revoked = 'Revoked',
}

const authorizationEvents = new Set<string>([
  EventIdEnum.AuthorizationAdded,
  EventIdEnum.AuthorizationConsumed,
  EventIdEnum.AuthorizationRejected,
  EventIdEnum.AuthorizationRevoked,
]);

const isAuthorizationEvent = (e: string): e is EventIdEnum => authorizationEvents.has(e);

const authorizationEventStatusMapping = new Map<EventIdEnum, AuthorizationStatus>([
  [EventIdEnum.AuthorizationConsumed, AuthorizationStatus.Consumed],
  [EventIdEnum.AuthorizationRevoked, AuthorizationStatus.Revoked],
  [EventIdEnum.AuthorizationRejected, AuthorizationStatus.Rejected],
]);

export async function mapAuthorization(
  blockId: number,
  eventId: EventIdEnum,
  moduleId: ModuleIdEnum,
  params: Codec[]
): Promise<void> {
  if (moduleId === ModuleIdEnum.Identity && isAuthorizationEvent(eventId)) {
    if (authorizationEventStatusMapping.has(eventId)) {
      const auth = await Authorization.get(params[2].toString());
      auth.status = authorizationEventStatusMapping.get(eventId);
      auth.updatedBlock = blockId;
      await auth.save();
    } else {
      await Authorization.create({
        id: params[3].toString(),
        createdBlock: blockId,
        authId: Number(params[3].toString()),
        fromDid: getTextValue(params[0]),
        toDid: getTextValue(params[1]),
        toKey: serializeAccount(params[2]),
        type: capitalizeFirstLetter(getFirstKeyFromJson(params[4])),
        data: getFirstValueFromJson(params[4]),
        expiry: getDateValue(params[5]),
        status: AuthorizationStatus.Pending,
        updatedBlock: blockId,
      }).save();
    }
  }
}
