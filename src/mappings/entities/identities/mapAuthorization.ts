import { SubstrateEvent } from '@subql/types';
import { Authorization, AuthorizationStatusEnum, AuthTypeEnum, EventIdEnum } from '../../../types';
import { getFirstKeyFromJson, getFirstValueFromJson, getTextValue } from '../../../utils';
import { capitalizeFirstLetter, getDateValue, serializeAccount } from '../../../utils';
import { extractArgs } from '../common';
import { createIdentityIfNotExists } from './mapIdentities';

const authorizationEventStatusMapping = new Map<EventIdEnum, AuthorizationStatusEnum>([
  [EventIdEnum.AuthorizationConsumed, AuthorizationStatusEnum.Consumed],
  [EventIdEnum.AuthorizationRevoked, AuthorizationStatusEnum.Revoked],
  [EventIdEnum.AuthorizationRejected, AuthorizationStatusEnum.Rejected],
]);

export async function handleAuthorization(event: SubstrateEvent): Promise<void> {
  const { eventId, blockId, params, eventIdx, block } = extractArgs(event);

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
