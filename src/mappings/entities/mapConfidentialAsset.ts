import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { ConfidentialAsset, ConfidentialVenue, EventIdEnum } from '../../types';
import { getBigIntValue, getBooleanValue, getNumberValue, getTextValue } from '../../utils/common';
import { Attributes, extractArgs } from './common';

export const getAuditorsAndMediators = (
  item: Codec
): Pick<Attributes<ConfidentialAsset>, 'auditors' | 'mediators'> => {
  const { auditors, mediators } = JSON.parse(item.toString());

  return {
    auditors,
    mediators,
  };
};

export const handleConfidentialAssetCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, eventIdx } = extractArgs(event);
  const [rawCreator, rawAssetId, , rawAuditorsMediators] = params;

  const creatorId = getTextValue(rawCreator);
  const assetId = getTextValue(rawAssetId);
  const { auditors, mediators } = getAuditorsAndMediators(rawAuditorsMediators);

  await ConfidentialAsset.create({
    id: assetId,
    assetId,
    creatorId,
    auditors,
    mediators,
    totalSupply: BigInt(0),
    venueFiltering: false,
    isFrozen: false,
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const handleConfidentialAssetIssuedOrBurned = async (
  event: SubstrateEvent
): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const [, rawAssetId, , rawTotalSupply] = params;

  const assetId = getTextValue(rawAssetId);
  const totalSupply = getBigIntValue(rawTotalSupply);

  const asset = await ConfidentialAsset.get(assetId);

  if (asset) {
    asset.totalSupply = totalSupply;
    asset.updatedBlockId = blockId;

    await asset.save();
  }
};

export const handleConfidentialVenueCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId } = extractArgs(event);

  const [rawCreator, rawVenueId] = params;

  const creatorId = getTextValue(rawCreator);
  const venueId = getNumberValue(rawVenueId);

  await ConfidentialVenue.create({
    id: `${venueId}`,
    venueId,
    creatorId,
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const handleVenuesAllowed = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawAssetId, rawVenueId] = params;

  const assetId = getTextValue(rawAssetId);
  const venuesAllowed = JSON.parse(rawVenueId.toString()).map(val => getNumberValue(val)) || [];

  const asset = await ConfidentialAsset.get(assetId);

  if (asset) {
    const existingVenues = asset.allowedVenues || [];
    asset.allowedVenues = [...new Set([...venuesAllowed, ...existingVenues])];
    asset.updatedBlockId = blockId;

    await asset.save();
  }
};

export const handleVenuesBlocked = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawAssetId, rawVenueId] = params;

  const assetId = getTextValue(rawAssetId);
  const blockedVenues = JSON.parse(rawVenueId.toString()).map(val => getNumberValue(val));

  const asset = await ConfidentialAsset.get(assetId);

  if (asset) {
    asset.allowedVenues = asset.allowedVenues?.filter(val => !blockedVenues.includes(val));
    asset.updatedBlockId = blockId;

    await asset.save();
  }
};

export const handleVenueFiltering = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const [, rawAssetId, rawEnabled] = params;
  const assetId = getTextValue(rawAssetId);
  const enabled = getBooleanValue(rawEnabled);

  const asset = await ConfidentialAsset.get(assetId);

  if (asset) {
    asset.venueFiltering = enabled;
    asset.updatedBlockId = blockId;

    await asset.save();
  }
};

export const handleAssetFrozenUnfrozen = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventId, blockId } = extractArgs(event);

  const [, rawAssetId] = params;

  const assetId = getTextValue(rawAssetId);

  const asset = await ConfidentialAsset.get(assetId);

  if (asset) {
    asset.isFrozen = eventId === EventIdEnum.AssetFrozen;
    asset.updatedBlockId = blockId;

    await asset.save();
  }
};

export const handleConfidentialAssetMoveFunds = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, eventIdx } = extractArgs(event);

  const [, rawFrom, rawTo, rawProofs] = params;

  const fromId = getTextValue(rawFrom);
  const toId = getTextValue(rawTo);

  const proofs = JSON.parse(rawProofs.toString());

  const proofParams = Object.keys(proofs).map(assetId => ({
    id: `${blockId}/${eventIdx}`,
    fromId,
    toId,
    assetId,
    proof: proofs[assetId],
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }));

  await store.bulkCreate('ConfidentialAssetMovement', proofParams);
};
