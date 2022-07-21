import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { EventIdEnum, ModuleIdEnum, Portfolio, PortfolioMovement } from '../../types';
import {
  getBigIntValue,
  getNumberValue,
  getPortfolioValue,
  getSignerAddress,
  getTextValue,
  serializeTicker,
} from '../util';
import { Attributes, HandlerArgs } from './common';

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

const handlePortfolioCreated = async (
  blockId: string,
  params: Codec[],
  eventIdx: number
): Promise<void> => {
  const [rawOwnerDid, rawPortfolioNumber, rawName] = params;

  const ownerId = getTextValue(rawOwnerDid);
  const number = getNumberValue(rawPortfolioNumber);
  const name = getTextValue(rawName);

  await createPortfolio(
    {
      identityId: ownerId,
      number,
      name,
      eventIdx,
    },
    blockId
  );
};

const handlePortfolioRenamed = async (blockId: string, params: Codec[]): Promise<void> => {
  const [rawOwnerDid, rawPortfolioNumber, rawName] = params;

  const ownerId = getTextValue(rawOwnerDid);
  const number = getNumberValue(rawPortfolioNumber);
  const name = getTextValue(rawName);

  const portfolio = await getPortfolio({ identityId: ownerId, number });
  portfolio.name = name;
  portfolio.updatedBlockId = blockId;

  await portfolio.save();
};

const handlePortfolioDeleted = async (params: Codec[]): Promise<void> => {
  const [rawOwnerDid, rawPortfolioNumber] = params;

  const ownerId = getTextValue(rawOwnerDid);
  const number = getNumberValue(rawPortfolioNumber);

  await Portfolio.remove(`${ownerId}/${number}`);
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
  const [, rawFromPortfolio, rawToPortfolio, rawTicker, rawAmount] = params;
  const address = getSignerAddress(event);
  const from = getPortfolioValue(rawFromPortfolio);
  const to = getPortfolioValue(rawToPortfolio);
  const ticker = serializeTicker(rawTicker);
  const amount = getBigIntValue(rawAmount);

  await PortfolioMovement.create({
    id: `${blockId}/${event.idx}`,
    fromId: `${from.identityId}/${from.number}`,
    toId: `${to.identityId}/${to.number}`,
    assetId: ticker,
    amount,
    address,
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
      await handlePortfolioDeleted(params);
    }
    if (eventId === EventIdEnum.MovedBetweenPortfolios) {
      await handlePortfolioMovement(blockId, params, event);
    }
  }
}
