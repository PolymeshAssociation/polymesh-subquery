import { Codec } from '@polkadot/types/types';
import {
  EventIdEnum,
  ModuleIdEnum,
  ConfidentialAssetHolder,
  ConfidentialAssetHistory,
} from '../../types';
import { getTextValue } from '../util';
import { HandlerArgs } from './common';

type AssetHolderParams = {
  id: string;
  accountId: string;
  assetId: string;
  amount: string;
  balance: string;
};

const extractAssetHolderParams = (params: Codec[]): AssetHolderParams => {
  const [rawAccountId, rawAssetId, rawAmount, rawBalance] = params;

  const accountId = getTextValue(rawAccountId);
  const assetId = getTextValue(rawAssetId);
  const amount = getTextValue(rawAmount);
  const balance = getTextValue(rawBalance);
  const id = `${assetId}/${accountId}`;

  return { id, accountId, assetId, amount, balance };
};

const handleConfidentialTransaction = async ({
  blockId,
  eventIdx,
  eventId,
  params,
  block,
}: HandlerArgs): Promise<void> => {
  const { id, accountId, assetId, amount, balance } = extractAssetHolderParams(params);

  const existingAssetHolder = await ConfidentialAssetHolder.get(id);

  if (existingAssetHolder) {
    existingAssetHolder.amount = balance;
    existingAssetHolder.updatedBlockId = blockId;

    await existingAssetHolder.save();
  } else {
    await ConfidentialAssetHolder.create({
      id,
      accountId,
      assetId,
      amount: balance,
      eventIdx,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  }

  await ConfidentialAssetHistory.create({
    id: `${id}/${eventIdx}`,
    assetId,
    amount,
    fromId: eventId === EventIdEnum.AccountWithdraw ? accountId : undefined,
    toId: eventId === EventIdEnum.AccountDeposit ? accountId : undefined,
    eventId,
    eventIdx,
    datetime: block.timestamp,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

const handleAccountDepositIncoming = async ({
  blockId,
  eventIdx,
  eventId,
  params,
  block,
}: HandlerArgs): Promise<void> => {
  const { id, assetId, amount, accountId } = extractAssetHolderParams(params);

  await ConfidentialAssetHistory.create({
    id: `${id}/${eventIdx}`,
    assetId,
    amount,
    eventId,
    eventIdx,
    toId: accountId,
    datetime: block.timestamp,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const mapConfidentialAssetTransaction = async (args: HandlerArgs): Promise<void> => {
  const { moduleId, eventId } = args;

  if (moduleId !== ModuleIdEnum.confidentialasset) {
    return;
  }

  if ([EventIdEnum.AccountDeposit, EventIdEnum.AccountWithdraw].includes(eventId)) {
    await handleConfidentialTransaction(args);
  }

  if (eventId === EventIdEnum.AccountDepositIncoming) {
    await handleAccountDepositIncoming(args);
  }
};
