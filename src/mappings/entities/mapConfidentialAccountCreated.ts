import { SubstrateEvent } from '@subql/types';
import { ConfidentialAccount } from '../../types';
import { getTextValue } from '../../utils';
import { extractArgs, HandlerArgs } from './common';

export const handleConfidentialAccountCreated = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, params, eventIdx } = extractArgs(event);

  const [rawCreator, rawAccount] = params;

  const creator = getTextValue(rawCreator);
  const account = getTextValue(rawAccount);

  await ConfidentialAccount.create({
    id: account,
    account,
    creatorId: creator,
    eventIdx,
    frozenForAsset: [],
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const handleConfidentialAssetFrozenForAccount = async (
  event: SubstrateEvent
): Promise<void> => {
  const { blockId, params } = extractArgs(event);
  const [, rawAccount, rawAsset] = params;

  const accountId = getTextValue(rawAccount);
  const assetId = getTextValue(rawAsset);

  const account = await ConfidentialAccount.get(accountId);

  if (account && !account.frozenForAsset.includes(assetId)) {
    account.frozenForAsset = [...account.frozenForAsset, assetId];
    account.updatedBlockId = blockId;

    await account.save();
  }
};

export const handleConfidentialAssetUnfrozenForAccount = async (
  args: HandlerArgs
): Promise<void> => {
  const { blockId, params } = args;
  const [, rawAccount, rawAsset] = params;

  const accountId = getTextValue(rawAccount);
  const assetId = getTextValue(rawAsset);

  const account = await ConfidentialAccount.get(accountId);

  if (account?.frozenForAsset.includes(assetId)) {
    account.frozenForAsset = account.frozenForAsset.filter(id => id !== assetId);
    account.updatedBlockId = blockId;

    await account.save();
  }
};
