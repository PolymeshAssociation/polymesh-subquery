import { SubstrateEvent } from '@subql/types';
import { ConfidentialAccount, ConfidentialEncryptionKey } from '../../../types';
import { getTextValue } from '../../../utils';
import { isObject, jsonOf } from '../../../utils/codec';
import { extractArgs, HandlerArgs } from '../common';

/** A key can be seen twice, by each event that names it: the first one created it */
const createEncryptionKey = async (
  encryptionKey: string,
  creatorId: string,
  { blockEventId }: Pick<HandlerArgs, 'eventIdx' | 'blockId' | 'blockEventId'>
): Promise<void> => {
  if (await ConfidentialEncryptionKey.get(encryptionKey)) {
    return;
  }

  await ConfidentialEncryptionKey.create({
    id: encryptionKey,
    encryptionKey,
    creatorId,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();
};

export const handleConfidentialAccountRegistered = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const { params, blockEventId } = args;

  const [rawDid, rawAccount, rawEncryptionKey] = params;

  const creatorId = getTextValue(rawDid);
  const account = getTextValue(rawAccount);
  const encryptionKey = getTextValue(rawEncryptionKey);

  await Promise.all([
    ConfidentialAccount.create({
      id: account,
      publicKey: account,
      encryptionKeyId: encryptionKey,
      creatorId,
      createdEventId: blockEventId,
      updatedEventId: blockEventId,
    }).save(),
    createEncryptionKey(encryptionKey, creatorId, args),
  ]);
};

export const handleConfidentialEncryptionKeyRegistered = async (
  event: SubstrateEvent
): Promise<void> => {
  const args = extractArgs(event);

  const [rawDid, rawEncryptionKey] = args.params;

  await createEncryptionKey(getTextValue(rawEncryptionKey), getTextValue(rawDid), args);
};

interface KeyDistributionProof {
  recipientPks: string[];
}

const isKeyDistributionProof = (json: unknown): json is KeyDistributionProof =>
  isObject(json) &&
  Array.isArray(json.recipientPks) &&
  json.recipientPks.every(key => typeof key === 'string');

/**
 * A shared key distributed to recipient encryption keys (from 8.2). The same call registers the
 * shared key first, with its own `EncryptionKeyRegistered`, so its row exists by now. The chain
 * never changes the recipients afterwards, so the rows are only ever created.
 */
export const handleConfidentialEncryptionKeyDistributed = async (
  event: SubstrateEvent
): Promise<void> => {
  const { params, blockEventId } = extractArgs(event);

  const [, rawEncryptionKey, rawProof] = params;

  const sharedKeyId = getTextValue(rawEncryptionKey);
  const { recipientPks } = jsonOf(rawProof, isKeyDistributionProof, 'KeyDistributionProof');

  if (recipientPks.length > 0) {
    await store.bulkCreate(
      'ConfidentialSharedKeyRecipient',
      [...new Set(recipientPks)].map(recipientId => ({
        id: `${sharedKeyId}/${recipientId}`,
        sharedKeyId,
        recipientId,
        createdEventId: blockEventId,
      }))
    );
  }
};
