import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { ConfidentialAssetHistory, ConfidentialAssetHolder, EventIdEnum } from '../../../types';
import { getTextValue } from '../../../utils';
import { extractArgs } from '../common';

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

export const handleConfidentialDepositOrWithdraw = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, eventIdx, eventId, block, blockEventId } = extractArgs(event);
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
      createdEventId: blockEventId,
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
    createdEventId: blockEventId,
  }).save();
};

export const handleAccountDepositIncoming = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, eventId, block, blockId, blockEventId } = extractArgs(event);

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
    createdEventId: blockEventId,
  }).save();
};
