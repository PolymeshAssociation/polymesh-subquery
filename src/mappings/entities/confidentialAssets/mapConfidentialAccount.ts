import { SubstrateEvent } from '@subql/types';
import { ConfidentialAccount, ConfidentialEncryptionKey } from '../../../types';
import { getTextValue } from '../../../utils';
import { extractArgs, HandlerArgs } from '../common';

const createEncryptionKey = (
  encryptionKey: string,
  creatorId: string,
  { blockEventId }: Pick<HandlerArgs, 'eventIdx' | 'blockId' | 'blockEventId'>
): Promise<void> =>
  ConfidentialEncryptionKey.create({
    id: encryptionKey,
    encryptionKey,
    creatorId,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();

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
      account,
      encryptionKey,
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
