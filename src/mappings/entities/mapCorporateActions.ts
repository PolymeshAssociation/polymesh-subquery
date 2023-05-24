import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { Distribution, DistributionPayment, EventIdEnum, ModuleIdEnum } from '../../types';
import { getBigIntValue, getCaIdValue, getDistributionValue, getTextValue } from '../util';
import { HandlerArgs } from './common';

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
  if (moduleId === ModuleIdEnum.capitaldistribution) {
    if (eventId === EventIdEnum.Created) {
      await handleDistributionCreated(blockId, params);
    }
    if (eventId === EventIdEnum.BenefitClaimed) {
      await handleBenefitClaimed(blockId, eventId, params, event);
    }
    if (eventId === EventIdEnum.Reclaimed) {
      await handleReclaimed(blockId, eventId, params, event);
    }
    if (eventId === EventIdEnum.Removed) {
      await handleDistributionRemoved(params);
    }
  }
}

const handleDistributionCreated = async (blockId: string, params: Codec[]): Promise<void> => {
  const [rawDid, rawCaId, rawDistribution] = params;

  const { localId, assetId } = getCaIdValue(rawCaId);
  const distributionDetails = getDistributionValue(rawDistribution);

  await Distribution.create({
    id: `${assetId}/${localId}`,
    identityId: getTextValue(rawDid),
    localId,
    assetId,
    ...distributionDetails,
    taxes: BigInt(0),
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

const handleDistributionRemoved = async (params: Codec[]): Promise<void> => {
  const [, rawCaId] = params;

  const { localId, assetId } = getCaIdValue(rawCaId);

  await Distribution.remove(`${assetId}/${localId}`);
};

const handleBenefitClaimed = async (
  blockId: string,
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> => {
  const [, rawClaimantDid, rawCaId, , rawAmount, rawTax] = params;

  const targetId = getTextValue(rawClaimantDid);
  const { localId, assetId } = getCaIdValue(rawCaId);
  const amount = getBigIntValue(rawAmount);
  const taxPercent = getBigIntValue(rawTax);

  const distribution = await Distribution.get(`${assetId}/${localId}`);
  const tax = BigInt((amount * taxPercent) / BigInt(1000000));
  distribution.taxes += tax;
  distribution.updatedBlockId = blockId;

  const distributionPayment = DistributionPayment.create({
    id: `${blockId}/${event.idx}`,
    distributionId: `${assetId}/${localId}`,
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
  const { localId, assetId } = getCaIdValue(rawCaId);
  const amount = getBigIntValue(rawAmount);

  await DistributionPayment.create({
    id: `${blockId}/${event.idx}`,
    distributionId: `${assetId}/${localId}`,
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
