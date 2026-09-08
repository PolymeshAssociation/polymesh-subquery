import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { Authorization, AuthorizationStatusEnum, AuthTypeEnum, EventIdEnum } from '../../../types';
import {
  capitalizeFirstLetter,
  getDateValue,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  getTextValue,
  serializeAccount,
} from '../../../utils';
import { extractArgs } from '../common';
import { createIdentityIfNotExists } from './mapIdentities';

const authorizationEventStatusMapping = new Map<EventIdEnum, AuthorizationStatusEnum>([
  [EventIdEnum.AuthorizationConsumed, AuthorizationStatusEnum.Consumed],
  [EventIdEnum.AuthorizationRevoked, AuthorizationStatusEnum.Revoked],
  [EventIdEnum.AuthorizationRejected, AuthorizationStatusEnum.Rejected],
]);

export async function handleAuthorization(event: SubstrateEvent): Promise<void> {
  const { eventId, blockId, eventIdx, block, blockEventId } = extractArgs(event);
  const decoded = decodeEvent(event);

  if (authorizationEventStatusMapping.has(eventId)) {
    const authId = getTextValue(decoded.authId);
    const auth = await Authorization.get(authId);
    auth.status = authorizationEventStatusMapping.get(eventId);
    auth.updatedBlockId = blockId;

    await auth.save();
  } else {
    const fromId = getTextValue(decoded.fromDid);

    // For `identity.cdd_register_did` extrinsic with params including `SecondaryKey` along with `TargetAccount`, `AuthorizationAdded` event is triggered before `DidCreated` event.
    await createIdentityIfNotExists(fromId, blockId, eventId, eventIdx, block, blockEventId);
    const authId = getTextValue(decoded.authId);
    await Authorization.create({
      id: authId,
      fromId,
      toId: getTextValue(decoded.toDid),
      toKey: serializeAccount(decoded.toKey),
      type: capitalizeFirstLetter(getFirstKeyFromJson(decoded.authorizationData)) as AuthTypeEnum,
      data: JSON.stringify(getFirstValueFromJson(decoded.authorizationData)),
      expiry: getDateValue(decoded.expiry),
      status: AuthorizationStatusEnum.Pending,
      createdBlockId: blockId,
      updatedBlockId: blockId,
      createdEventId: blockEventId,
    }).save();
  }
}
