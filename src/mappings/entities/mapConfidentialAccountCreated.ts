import { ConfidentialAccount, EventIdEnum, ModuleIdEnum } from '../../types';
import { getTextValue } from '../util';
import { HandlerArgs } from './common';

const handleConfidentialAccountCreated = async (args: HandlerArgs): Promise<void> => {
  const { blockId, params, eventIdx } = args;

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

const handleConfidentialAssetFrozenForAccount = async (args: HandlerArgs): Promise<void> => {
  const { blockId, params } = args;
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

const handleConfidentialAssetUnfrozenForAccount = async (args: HandlerArgs): Promise<void> => {
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

export const mapConfidentialAccountCreated = async (args: HandlerArgs): Promise<void> => {
  const { moduleId, eventId } = args;

  if (moduleId !== ModuleIdEnum.confidentialasset) {
    return;
  }

  if (eventId === EventIdEnum.AccountCreated) {
    handleConfidentialAccountCreated(args);
  }

  if (eventId === EventIdEnum.AccountAssetFrozen) {
    await handleConfidentialAssetFrozenForAccount(args);
  }

  if (eventId === EventIdEnum.AccountAssetUnfrozen) {
    await handleConfidentialAssetUnfrozenForAccount(args);
  }
};
