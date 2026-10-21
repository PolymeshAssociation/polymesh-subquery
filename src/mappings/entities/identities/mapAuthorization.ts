import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import {
  Authorization,
  AuthorizationStatusEnum,
  AuthTypeEnum,
  EventIdEnum,
  MultiSigSigner,
  MultiSigSignerStatusEnum,
  SignerTypeEnum,
} from '../../../types';
import {
  blockTime,
  capitalizeFirstLetter,
  getDateValue,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  getTextValue,
  padNumericId,
} from '../../../utils';
import { extractArgs } from '../common';
import { offerStands } from '../multiSig/mapMultiSig';
import { endSubsidyOffer, offerSubsidy } from '../relayer/mapSubsidy';
import { createIdentityIfNotExists } from './mapIdentities';
import {
  canonicalPermissions,
  PERMISSION_AUTHORIZATIONS,
  Subset,
} from '../../../utils/permissions';

const authorizationEventStatusMapping = new Map<EventIdEnum, AuthorizationStatusEnum>([
  [EventIdEnum.AuthorizationConsumed, AuthorizationStatusEnum.Consumed],
  [EventIdEnum.AuthorizationRevoked, AuthorizationStatusEnum.Revoked],
  [EventIdEnum.AuthorizationRejected, AuthorizationStatusEnum.Rejected],
  [EventIdEnum.AuthorizationRetryLimitReached, AuthorizationStatusEnum.RetryLimitReached],
]);

export async function handleAuthorization(event: SubstrateEvent): Promise<void> {
  const { eventId, blockId, eventIdx, block, blockEventId } = extractArgs(event);
  const decoded = decodeEvent(event);

  if (authorizationEventStatusMapping.has(eventId)) {
    const authId = padNumericId(getTextValue(decoded.authId));
    const auth = await Authorization.get(authId);

    // The row is absent only for an authorization created before the index start; a terminal
    // event for one of those has nothing to update.
    if (!auth) {
      return;
    }

    auth.status = authorizationEventStatusMapping.get(eventId);
    auth.updatedEventId = blockEventId;

    await Promise.all([
      auth.save(),
      auth.status === AuthorizationStatusEnum.Consumed
        ? undefined
        : endOffer(auth, block, eventIdx, blockEventId),
    ]);
  } else {
    const fromId = getTextValue(decoded.authorizedBy);

    // For `identity.cdd_register_did` extrinsic with params including `SecondaryKey` along with `TargetAccount`, `AuthorizationAdded` event is triggered before `DidCreated` event.
    await createIdentityIfNotExists(fromId, blockId, eventId, eventIdx, block, blockEventId);
    const authId = padNumericId(getTextValue(decoded.authId));
    const type = capitalizeFirstLetter(
      getFirstKeyFromJson(decoded.authorizationData)
    ) as AuthTypeEnum;
    const payload: unknown = getFirstValueFromJson(decoded.authorizationData);
    const data =
      PERMISSION_AUTHORIZATIONS.has(type) && payload && typeof payload === 'object'
        ? canonicalPermissions(payload as Subset)
        : payload;
    await Authorization.create({
      id: authId,
      fromId,
      toId: decoded.targetDid.isEmpty ? undefined : getTextValue(decoded.targetDid),
      toAccountId: decoded.targetKey.isEmpty ? undefined : getTextValue(decoded.targetKey),
      type,
      data: JSON.stringify(data),
      expiry: getDateValue(decoded.expiry),
      status: AuthorizationStatusEnum.Pending,
      createdEventId: blockEventId,
      updatedEventId: blockEventId,
    }).save();

    // the offer a paying-key authorization makes, which `identity.add_authorization` raises with
    // no relayer event; the paying key, its target, accepts it
    if (PAYING_KEY_TYPES.has(type) && Array.isArray(data)) {
      const [userKey, payingKey, limit] = data as [string, string, string | number];
      await offerSubsidy(
        { userKey, payingKey, limit: BigInt(limit) },
        { block, blockId, blockEventId }
      );
    }
  }
}

const PAYING_KEY_TYPES = new Set(['AddRelayerPayingKey', 'OldAddRelayerPayingKey']);

/**
 * An authorization that ended unaccepted ends the offer it made, which no other event does: a
 * multisig signer that never joined, a subsidy that never started.
 */
const endOffer = async (
  auth: Authorization,
  block: SubstrateBlock,
  eventIdx: number,
  blockEventId: string
): Promise<void> => {
  const data: unknown = auth.data ? JSON.parse(auth.data) : undefined;

  if (auth.type === AuthTypeEnum.AddMultiSigSigner && typeof data === 'string') {
    const [signerType, signerValue] = auth.toAccountId
      ? [SignerTypeEnum.Account, auth.toAccountId]
      : [SignerTypeEnum.Identity, auth.toId];
    const signer = await MultiSigSigner.get(`${data}/${signerType}/${signerValue}`);
    if (
      signer?.status === MultiSigSignerStatusEnum.Authorized &&
      !(await offerStands(signer, blockTime(block), auth.id))
    ) {
      signer.status = MultiSigSignerStatusEnum.Removed;
      signer.updatedEventId = blockEventId;
      await signer.save();
    }
  }

  if (PAYING_KEY_TYPES.has(auth.type) && Array.isArray(data)) {
    const [user, payer] = data as string[];
    await endSubsidyOffer(user, payer, block, eventIdx, blockEventId);
  }
};
