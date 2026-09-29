import { SubstrateEvent } from '@subql/types';
import { CorporateAction, Distribution, DistributionPayment } from '../../../types';
import { getBigIntValue, getCaIdValue, getDistributionValue, getTextValue } from '../../../utils';
import { extractArgs, getOrAnomaly } from '../common';

export const handleDistributionCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, block, blockEventId } = extractArgs(event);
  const [rawDid, rawCaId, rawDistribution] = params;

  const { localId, assetId } = await getCaIdValue(rawCaId, block);
  const distributionDetails = await getDistributionValue(rawDistribution, block);

  if (!distributionDetails) {
    return;
  }

  const corporateAction = await getOrAnomaly(
    id => CorporateAction.get(id),
    `${assetId}/${localId}`,
    'CorporateAction',
    event
  );
  const caId = corporateAction?.id;

  await Distribution.create({
    id: `${assetId}/${localId}`,
    identityId: getTextValue(rawDid),
    localId,
    assetId,
    // A distribution is a corporate action plus payout terms, and the chain keys both on the same
    // `CAId`, so the relation is the id this row already has — but the action was created by an
    // earlier extrinsic, which can be outside the index. The row is still worth keeping when it is:
    // its payout terms stand on their own, and the payments that reference it are not optional.
    corporateActionId: caId,
    ...distributionDetails,
    taxes: BigInt(0),
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();
};

export const handleDistributionRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { params, block } = extractArgs(event);
  const [, rawCaId] = params;

  const { localId, assetId } = await getCaIdValue(rawCaId, block);

  await Distribution.remove(`${assetId}/${localId}`);
};

export const handleBenefitClaimed = async (event: SubstrateEvent): Promise<void> => {
  const { params, block, blockEventId } = extractArgs(event);
  const [, rawClaimantDid, rawCaId, , rawAmount, rawTax] = params;

  const targetId = getTextValue(rawClaimantDid);
  const { localId, assetId } = await getCaIdValue(rawCaId, block);
  const amount = getBigIntValue(rawAmount);
  const tax = getBigIntValue(rawTax);

  const distribution = await getOrAnomaly(
    id => Distribution.get(id),
    `${assetId}/${localId}`,
    'Distribution',
    event
  );

  // The payment names the distribution by id, and the distribution is what the tax accrues to —
  // without it there is nothing to accrue to, and a payment pointing at nothing, so both are
  // recorded as missing rather than the block failing on the first field.
  if (!distribution) {
    return;
  }

  const taxAmount = BigInt((amount * tax) / BigInt(1000000));
  distribution.taxes += taxAmount;
  distribution.updatedEventId = blockEventId;

  const distributionPayment = DistributionPayment.create({
    id: blockEventId,
    distributionId: `${assetId}/${localId}`,
    targetId,
    amount,
    tax,
    amountAfterTax: amount - taxAmount,
    reclaimed: false,
    createdEventId: blockEventId,
  });

  await Promise.all([distributionPayment.save(), distribution.save()]);
};

export const handleReclaimed = async (event: SubstrateEvent): Promise<void> => {
  const { params, block, blockEventId } = extractArgs(event);
  const [rawEventDid, rawCaId, rawAmount] = params;

  const targetId = getTextValue(rawEventDid);
  const { localId, assetId } = await getCaIdValue(rawCaId, block);
  const amount = getBigIntValue(rawAmount);

  await DistributionPayment.create({
    id: blockEventId,
    distributionId: `${assetId}/${localId}`,
    targetId,
    amount,
    tax: BigInt(0),
    amountAfterTax: amount,
    reclaimed: true,
    createdEventId: blockEventId,
  }).save();
};
