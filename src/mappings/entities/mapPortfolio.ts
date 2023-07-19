import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { EventIdEnum, ModuleIdEnum, Portfolio, PortfolioMovement } from '../../types';
import {
  bytesToString,
  getBigIntValue,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  getNumberValue,
  getPortfolioValue,
  getSignerAddress,
  getTextValue,
  hexToString,
  serializeTicker,
} from '../util';
import { Attributes, HandlerArgs } from './common';
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
  event: SubstrateEvent
): Promise<void> => {
  await createIdentityIfNotExists(identityId, blockId, event);

  const portfolio = await Portfolio.get(`${identityId}/${number}`);
  if (!portfolio) {
    await createPortfolio(
      {
        identityId,
        number,
        name: '',
        eventIdx: event.idx,
      },
      blockId
    );
  }
};

const handlePortfolioCreated = async (
  blockId: string,
  params: Codec[],
  eventIdx: number
): Promise<void> => {
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

const handlePortfolioRenamed = async (blockId: string, params: Codec[]): Promise<void> => {
  const [rawOwnerDid, rawPortfolioNumber, rawName] = params;

  const ownerId = getTextValue(rawOwnerDid);
  const number = getNumberValue(rawPortfolioNumber);
  const name = bytesToString(rawName);

  const portfolio = await getPortfolio({ identityId: ownerId, number });
  portfolio.name = name;
  portfolio.updatedBlockId = blockId;

  await portfolio.save();
};

const handlePortfolioDeleted = async (
  blockId: string,
  params: Codec[],
  datetime: Date
): Promise<void> => {
  const [rawOwnerDid, rawPortfolioNumber] = params;

  const ownerId = getTextValue(rawOwnerDid);
  const number = getNumberValue(rawPortfolioNumber);

  const portfolio = await Portfolio.get(`${ownerId}/${number}`);
  portfolio.deletedAt = datetime;
  portfolio.updatedBlockId = blockId;

  await portfolio.save();
};

const handlePortfolioCustodianChanged = async (blockId: string, params: Codec[]): Promise<void> => {
  const [, rawPortfolio, rawCustodian] = params;

  const portfolioValue = getPortfolioValue(rawPortfolio);
  const custodian = getTextValue(rawCustodian);

  const portfolio = await getPortfolio(portfolioValue);
  portfolio.custodianId = custodian;
  portfolio.updatedBlockId = blockId;

  await portfolio.save();
};

const handlePortfolioMovement = async (
  blockId: string,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> => {
  const [, rawFromPortfolio, rawToPortfolio, rawTicker, rawAmount, rawMemo] = params;
  const address = getSignerAddress(event);
  const from = getPortfolioValue(rawFromPortfolio);
  const to = getPortfolioValue(rawToPortfolio);
  const ticker = serializeTicker(rawTicker);
  const amount = getBigIntValue(rawAmount);
  const memo = bytesToString(rawMemo);

  await PortfolioMovement.create({
    id: `${blockId}/${event.idx}`,
    fromId: `${from.identityId}/${from.number}`,
    toId: `${to.identityId}/${to.number}`,
    assetId: ticker,
    amount,
    address,
    memo,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

const handleFundsMovedBetweenPortfolios = async (
  blockId: string,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> => {
  const [, rawFromPortfolio, rawToPortfolio, rawFundDescription, rawMemo] = params;
  const address = getSignerAddress(event);
  const from = getPortfolioValue(rawFromPortfolio);
  const to = getPortfolioValue(rawToPortfolio);
  let ticker: string, amount: bigint;

  const assetType = getFirstKeyFromJson(rawFundDescription);
  const fundDescription = getFirstValueFromJson(rawFundDescription);
  if (assetType === 'fungible') {
    const description = fundDescription as unknown as { ticker: string; amount: number };
    ticker = hexToString(description.ticker);
    amount = BigInt(description.amount);
  } else {
    // @prashantasdeveloper handling of NFTs to be done separately
    return;
  }

  const memo = bytesToString(rawMemo);

  await PortfolioMovement.create({
    id: `${blockId}/${event.idx}`,
    fromId: `${from.identityId}/${from.number}`,
    toId: `${to.identityId}/${to.number}`,
    assetId: ticker,
    amount,
    address,
    memo,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export async function mapPortfolio({
  blockId,
  eventId,
  moduleId,
  params,
  event,
}: HandlerArgs): Promise<void> {
  if (moduleId === ModuleIdEnum.portfolio) {
    if (eventId === EventIdEnum.PortfolioCreated) {
      await handlePortfolioCreated(blockId, params, event.idx);
    }
    if (eventId === EventIdEnum.PortfolioRenamed) {
      await handlePortfolioRenamed(blockId, params);
    }
    if (eventId === EventIdEnum.PortfolioCustodianChanged) {
      await handlePortfolioCustodianChanged(blockId, params);
    }
    if (eventId === EventIdEnum.PortfolioDeleted) {
      await handlePortfolioDeleted(blockId, params, event.block.timestamp);
    }
    if (eventId === EventIdEnum.MovedBetweenPortfolios) {
      await handlePortfolioMovement(blockId, params, event);
    }
    if (eventId === EventIdEnum.FundsMovedBetweenPortfolios) {
      await handleFundsMovedBetweenPortfolios(blockId, params, event);
    }
  }
}
