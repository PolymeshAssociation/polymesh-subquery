import { SubstrateEvent } from '@subql/types';
import { Distribution, DistributionPayment } from '../../../types';
import { getBigIntValue, getCaIdValue, getDistributionValue, getTextValue } from '../../../utils';
import { extractArgs } from '../common';

export const handleDistributionCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block } = extractArgs(event);
  const [rawDid, rawCaId, rawDistribution] = params;

  const { localId, assetId } = await getCaIdValue(rawCaId, block);
  const distributionDetails = await getDistributionValue(rawDistribution, block);

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

export const handleDistributionRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { params, block } = extractArgs(event);
  const [, rawCaId] = params;

  const { localId, assetId } = await getCaIdValue(rawCaId, block);

  await Distribution.remove(`${assetId}/${localId}`);
};

export const handleBenefitClaimed = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, eventId, block, eventIdx } = extractArgs(event);
  const [, rawClaimantDid, rawCaId, , rawAmount, rawTax] = params;

  const targetId = getTextValue(rawClaimantDid);
  const { localId, assetId } = await getCaIdValue(rawCaId, block);
  const amount = getBigIntValue(rawAmount);
  const tax = getBigIntValue(rawTax);

  const distribution = await Distribution.get(`${assetId}/${localId}`);
  const taxAmount = BigInt((amount * tax) / BigInt(1000000));
  distribution.taxes += taxAmount;
  distribution.updatedBlockId = blockId;

  const distributionPayment = DistributionPayment.create({
    id: `${blockId}/${eventIdx}`,
    distributionId: `${assetId}/${localId}`,
    targetId,
    eventId,
    amount,
    tax,
    amountAfterTax: amount - taxAmount,
    reclaimed: false,
    datetime: block.timestamp,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  });

  await Promise.all([distributionPayment.save(), distribution.save()]);
};

export const handleReclaimed = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, eventIdx, block, eventId } = extractArgs(event);
  const [rawEventDid, rawCaId, rawAmount] = params;

  const targetId = getTextValue(rawEventDid);
  const { localId, assetId } = await getCaIdValue(rawCaId, block);
  const amount = getBigIntValue(rawAmount);

  await DistributionPayment.create({
    id: `${blockId}/${eventIdx}`,
    distributionId: `${assetId}/${localId}`,
    targetId,
    eventId,
    amount,
    tax: BigInt(0),
    amountAfterTax: amount,
    reclaimed: true,
    datetime: block.timestamp,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};
