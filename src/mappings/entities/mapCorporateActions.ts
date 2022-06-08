import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { Distribution, DistributionPayment } from '../../types';
import {
  getAmountValue,
  getBigIntValue,
  getCaIdValue,
  getPortfolioValue,
  getTextValue,
} from '../util';
import { EventIdEnum, HandlerArgs, ModuleIdEnum } from './common';

/**
 * Subscribes to the CapitalDistribution events
 */
export async function mapCorporateActions({
  blockId,
  eventId,
  moduleId,
  params,
  event,
}: HandlerArgs): Promise<void> {
  if (moduleId === ModuleIdEnum.Capitaldistribution) {
    if (eventId === EventIdEnum.Created) {
      await handleDistributionCreated(blockId, params);
    }
    if (eventId === EventIdEnum.BenefitClaimed) {
      await handleBenefitClaimed(blockId, eventId, params, event);
    }
    if (eventId === EventIdEnum.Reclaimed) {
      await handleReclaimed(blockId, eventId, params, event);
    }
  }
}

const handleDistributionCreated = async (blockId: string, params: Codec[]): Promise<void> => {
  const [
    rawDid,
    rawCaId,
    rawPortfolio,
    rawCurrency,
    rawPerShare,
    rawAmount,
    rawRemaining,
    rawPaymentAt,
    rawExpiresAt,
  ] = params;

  const { localId, ticker } = getCaIdValue(rawCaId);
  const { identityId, number } = getPortfolioValue(rawPortfolio);

  await Distribution.create({
    id: `${ticker}/${localId}`,
    identityId: getTextValue(rawDid),
    localId,
    ticker,
    portfolioId: `${identityId}/${number}`,
    currency: getTextValue(rawCurrency),
    perShare: getAmountValue(rawPerShare),
    amount: getAmountValue(rawAmount),
    remaining: getAmountValue(rawRemaining),
    paymentAt: getBigIntValue(rawPaymentAt),
    expiresAt: getBigIntValue(rawExpiresAt),
    taxes: BigInt(0),
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

const handleBenefitClaimed = async (
  blockId: string,
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> => {
  const [rawEventDid, , rawCaId, rawAmount, rawTax] = params;

  const targetId = getTextValue(rawEventDid);
  const { localId, ticker } = getCaIdValue(rawCaId);
  const amount = getAmountValue(rawAmount);
  const tax = getBigIntValue(rawTax) / BigInt(10000);

  const distribution = await Distribution.get(`${ticker}/${localId}`);
  distribution.taxes += amount * tax;
  distribution.updatedBlockId = blockId;

  const distributionPayment = DistributionPayment.create({
    id: `${blockId}/${event.idx}`,
    distributionId: `${ticker}/${localId}`,
    targetId,
    eventId,
    amount,
    tax,
    reclaimed: false,
    datetime: event.block.timestamp,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  });

  await Promise.all([distributionPayment.save(), distribution.save()]);
};

const handleReclaimed = async (
  blockId: string,
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> => {
  const [rawEventDid, rawCaId, rawAmount] = params;

  const targetId = getTextValue(rawEventDid);
  const { localId, ticker } = getCaIdValue(rawCaId);
  const amount = getAmountValue(rawAmount);

  await DistributionPayment.create({
    id: `${blockId}/${event.idx}`,
    distributionId: `${ticker}/${localId}`,
    targetId,
    eventId,
    amount,
    tax: BigInt(0),
    reclaimed: true,
    datetime: event.block.timestamp,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};
