import { SubstrateEvent } from '@subql/types';
import { ConfidentialAccount } from '../../types';
import { getTextValue } from '../util';
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
  const { blockId, params, eventIdx } = extractArgs(event);
  const [rawCreator, rawAccount, rawAsset] = params;

  const accountId = getTextValue(rawAccount);
  const assetId = getTextValue(rawAsset);

  const account = await ConfidentialAccount.get(accountId);

  if (account && !Array.isArray(account.frozenForAsset)) {
    account.frozenForAsset = [assetId];

    await account.save();
  } else if (account && !account.frozenForAsset.includes(assetId)) {
    account.frozenForAsset = [...account.frozenForAsset, assetId];
    account.updatedBlockId = blockId;

    await account.save();
  } else if (!account) {
    const creatorId = getTextValue(rawCreator);

    await ConfidentialAccount.create({
      id: accountId,
      account: accountId,
      creatorId,
      eventIdx,
      frozenForAsset: [assetId],
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  }
};

export const handleConfidentialAssetUnfrozenForAccount = async (
  args: HandlerArgs
): Promise<void> => {
  const { blockId, params, eventIdx } = args;
  const [rawCreator, rawAccount, rawAsset] = params;

  const accountId = getTextValue(rawAccount);
  const assetId = getTextValue(rawAsset);

  const account = await ConfidentialAccount.get(accountId);

  if (account && !Array.isArray(account.frozenForAsset)) {
    account.frozenForAsset = [];

    await account.save();
  } else if (account?.frozenForAsset.includes(assetId)) {
    account.frozenForAsset = account.frozenForAsset.filter(id => id !== assetId);
    account.updatedBlockId = blockId;

    await account.save();
  } else if (!account) {
    const creatorId = getTextValue(rawCreator);

    await ConfidentialAccount.create({
      id: accountId,
      account: accountId,
      creatorId,
      eventIdx,
      frozenForAsset: [],
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  }
};
