import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { Portfolio, Settlement } from '../../types';
import {
  getBigIntValue,
  getNumberValue,
  getPortfolioValue,
  getSignerAddress,
  getTextValue,
  serializeTicker,
} from '../util';
import { Attributes, EventIdEnum, ModuleIdEnum } from './common';
import { createLeg, SettlementResultEnum } from './mapSettlement';

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

export const createPortfolio = (attributes: Attributes<Portfolio>): Promise<void> => {
  const { identityId, number } = attributes;
  return Portfolio.create({
    id: `${identityId}/${number}`,
    ...attributes,
  }).save();
};

const handlePortfolioCreated = async (blockId: string, params: Codec[]): Promise<void> => {
  const [rawOwnerDid, rawPortfolioNumber, rawName] = params;

  const ownerId = getTextValue(rawOwnerDid);
  const number = getNumberValue(rawPortfolioNumber);
  const name = getTextValue(rawName);

  await createPortfolio({
    identityId: ownerId,
    number,
    name,
    createdBlockId: blockId,
  });
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
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> => {
  const [, rawFromPortfolio, rawToPortfolio, rawTicker, rawAmount] = params;
  const address = getSignerAddress(event);
  const from = getPortfolioValue(rawFromPortfolio);
  const to = getPortfolioValue(rawToPortfolio);
  const ticker = serializeTicker(rawTicker);
  const amount = getBigIntValue(rawAmount);

  const settlementId = `${blockId}/${event.idx}`;
  const settlement = Settlement.create({
    id: settlementId,
    blockId,
    eventId,
    result: SettlementResultEnum.Executed,
    addresses: [address],
  }).save();

  await Promise.all([
    settlement,
    getPortfolio(from),
    getPortfolio(to),
    createLeg(blockId, event, null, settlementId, 0, { ticker, amount, from, to }),
  ]);
};

export async function mapPortfolio(
  blockId: string,
  eventId: EventIdEnum,
  moduleId: ModuleIdEnum,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> {
  if (moduleId === ModuleIdEnum.Portfolio) {
    if (eventId === EventIdEnum.PortfolioCreated) {
      await handlePortfolioCreated(blockId, params);
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
      await handlePortfolioMovement(blockId, eventId, params, event);
    }
  }
}
