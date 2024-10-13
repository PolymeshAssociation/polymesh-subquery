import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import {
  EventIdEnum,
  Portfolio,
  PortfolioMovement,
  PortfolioMovementTypeEnum,
} from '../../../types';
import {
  bytesToString,
  getAssetId,
  getBigIntValue,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  getNumberValue,
  getPortfolioValue,
  getSignerAddress,
  getTextValue,
} from '../../../utils';
import { Attributes, extractArgs } from '../common';
import { createIdentityIfNotExists } from './mapIdentities';

export const getPortfolio = async ({
  identityId,
  number,
}: Pick<Portfolio, 'identityId' | 'number'>): Promise<Portfolio> => {
  const portfolioId = `${identityId}/${number}`;

  const portfolio = await Portfolio.get(portfolioId);

  if (!portfolio) {
    throw new Error(`Portfolio number ${number} not found for DID ${identityId}`);
  }

  return portfolio;
};

export const createPortfolio = (
  attributes: Attributes<Portfolio>,
  blockId: string
): Promise<void> => {
  const { identityId, number } = attributes;
  return Portfolio.create({
    id: `${identityId}/${number}`,
    ...attributes,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

/**
 * Creates a Portfolio if not present.
 *
 * @note - WARNING: This is needed when an Instruction is created with a target Portfolio that doesn't exist. It should not be used unless necessary.
 */
export const createPortfolioIfNotExists = async (
  { identityId, number }: Pick<Portfolio, 'identityId' | 'number'>,
  blockId: string,
  eventId: EventIdEnum,
  eventIdx: number,
  block: SubstrateBlock
): Promise<void> => {
  await createIdentityIfNotExists(identityId, blockId, eventId, eventIdx, block);

  const portfolio = await Portfolio.get(`${identityId}/${number}`);
  if (!portfolio) {
    await createPortfolio(
      {
        identityId,
        number,
        name: '',
        eventIdx,
      },
      blockId
    );
  }
};

export const handlePortfolioCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, eventIdx } = extractArgs(event);
  const [rawOwnerDid, rawPortfolioNumber, rawName] = params;

  const ownerId = getTextValue(rawOwnerDid);
  const number = getNumberValue(rawPortfolioNumber);
  const name = bytesToString(rawName);

  const portfolio = await Portfolio.get(`${ownerId}/${number}`);
  if (!portfolio) {
    await createPortfolio(
      {
        identityId: ownerId,
        number,
        name,
        eventIdx,
      },
      blockId
    );
  } else {
    Object.assign(portfolio, {
      name,
      eventIdx,
      updatedBlockId: blockId,
    });

    await portfolio.save();
  }
};

export const handlePortfolioRenamed = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [rawOwnerDid, rawPortfolioNumber, rawName] = params;

  const ownerId = getTextValue(rawOwnerDid);
  const number = getNumberValue(rawPortfolioNumber);
  const name = bytesToString(rawName);

  const portfolio = await getPortfolio({ identityId: ownerId, number });

  portfolio.name = name;
  portfolio.updatedBlockId = blockId;

  await portfolio.save();
};

export const handlePortfolioDeleted = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block } = extractArgs(event);
  const [rawOwnerDid, rawPortfolioNumber] = params;

  const ownerId = getTextValue(rawOwnerDid);
  const number = getNumberValue(rawPortfolioNumber);

  const portfolio = await Portfolio.get(`${ownerId}/${number}`);
  portfolio.deletedAt = block.timestamp;
  portfolio.updatedBlockId = blockId;

  await portfolio.save();
};

export const handlePortfolioCustodianChanged = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawPortfolio, rawCustodian] = params;

  const portfolioValue = getPortfolioValue(rawPortfolio);
  const custodian = getTextValue(rawCustodian);

  const portfolio = await getPortfolio(portfolioValue);
  portfolio.custodianId = custodian;
  portfolio.updatedBlockId = blockId;

  await portfolio.save();
};

/**
 * Handles old event for portfolio movement
 */
export const handlePortfolioMovement = async (event: SubstrateEvent): Promise<void> => {
  const { params, extrinsic, blockId, block, eventIdx } = extractArgs(event);
  const [, rawFromPortfolio, rawToPortfolio, rawAssetId, rawAmount, rawMemo] = params;

  const address = getSignerAddress(extrinsic);
  const from = getPortfolioValue(rawFromPortfolio);
  const to = getPortfolioValue(rawToPortfolio);
  const assetId = getAssetId(rawAssetId, block);
  const amount = getBigIntValue(rawAmount);
  const memo = bytesToString(rawMemo);

  await PortfolioMovement.create({
    id: `${blockId}/${eventIdx}`,
    fromId: `${from.identityId}/${from.number}`,
    toId: `${to.identityId}/${to.number}`,
    type: PortfolioMovementTypeEnum.Fungible,
    assetId,
    amount,
    address,
    memo,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const handleFundsMovedBetweenPortfolios = async (event: SubstrateEvent): Promise<void> => {
  const { params, extrinsic, blockId, block, eventIdx } = extractArgs(event);
  const [, rawFromPortfolio, rawToPortfolio, rawFundDescription, rawMemo] = params;
  const address = getSignerAddress(extrinsic);
  const from = getPortfolioValue(rawFromPortfolio);
  const to = getPortfolioValue(rawToPortfolio);
  let assetId: string, amount: bigint, nftIds: bigint[];
  let type: PortfolioMovementTypeEnum;

  const assetType = getFirstKeyFromJson(rawFundDescription);
  const fundDescription = getFirstValueFromJson(rawFundDescription);
  if (assetType === 'fungible') {
    const description = fundDescription as unknown as {
      ticker?: string;
      assetId?: string;
      amount: number;
    };
    assetId = getAssetId(description.ticker ?? description.assetId, block);
    amount = BigInt(description.amount);
    type = PortfolioMovementTypeEnum.Fungible;
  } else if (assetType === 'nonFungible') {
    const description = fundDescription as unknown as {
      ticker?: string;
      assetId?: string;
      ids: number[];
    };
    nftIds = description.ids.map(id => BigInt(id));
    assetId = getAssetId(description.ticker ?? description.assetId, block);
    type = PortfolioMovementTypeEnum.NonFungible;
  }

  const memo = bytesToString(rawMemo);

  await PortfolioMovement.create({
    id: `${blockId}/${eventIdx}`,
    fromId: `${from.identityId}/${from.number}`,
    toId: `${to.identityId}/${to.number}`,
    type,
    assetId,
    amount,
    nftIds,
    address,
    memo,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};
