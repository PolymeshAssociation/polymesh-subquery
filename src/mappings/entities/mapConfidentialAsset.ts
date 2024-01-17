import { Codec } from '@polkadot/types/types';
import { ConfidentialAsset, ConfidentialVenue, EventIdEnum, ModuleIdEnum } from '../../types';
import { getBigIntValue, getBooleanValue, getTextValue, getNumberValue } from '../util';
import { HandlerArgs } from './common';

type ExtractedParties = {
  auditors: string[];
  mediators: string[];
};

const extractParties = (partiesCodec: Codec): ExtractedParties => {
  const { auditors, mediators } = JSON.parse(partiesCodec.toString()) || {};

  return { auditors, mediators };
};

const handleConfidentialAssetCreated = async (blockId: string, params: Codec[]): Promise<void> => {
  const creatorId = getTextValue(params[0]);
  const assetId = getTextValue(params[1]);
  const totalSupply = BigInt(0);
  const { auditors, mediators } = extractParties(params[2]);

  await ConfidentialAsset.create({
    id: assetId,
    assetId,
    creatorId,
    auditors,
    mediators,
    totalSupply,
    venueFiltering: false,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

const handleConfidentialAssetIssued = async (blockId: string, params: Codec[]): Promise<void> => {
  const assetId = getTextValue(params[1]);
  const totalSupply = getBigIntValue(params[3]);

  const asset = await ConfidentialAsset.get(assetId);

  asset.totalSupply = totalSupply;
  asset.updatedBlockId = blockId;

  await asset.save();
};

const handleVenueFiltering = async (blockId: string, params: Codec[]): Promise<void> => {
  const assetId = getTextValue(params[1]);
  const enabled = getBooleanValue(params[2]);

  const asset = await ConfidentialAsset.get(assetId);

  asset.venueFiltering = enabled;
  asset.updatedBlockId = blockId;

  await asset.save();
};

const handleVenuesAllowed = async (blockId: string, params: Codec[]): Promise<void> => {
  // TODO: implement
};

const handleVenuesBlocked = async (blockId: string, params: Codec[]): Promise<void> => {
  // TODO: implement
};

const handleVenueCreated = async (blockId: string, params: Codec[]): Promise<void> => {
  const creatorId = getTextValue(params[0]);
  const venueId = getNumberValue(params[1]);

  await ConfidentialVenue.create({
    id: `${venueId}`,
    venueId,
    creatorId,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const mapConfidentialAsset = async (args: HandlerArgs): Promise<void> => {
  const { blockId, moduleId, eventId, params } = args;

  if (moduleId !== ModuleIdEnum.confidentialasset) {
    return;
  }

  if (eventId === EventIdEnum.ConfidentialAssetCreated) {
    await handleConfidentialAssetCreated(blockId, params);
  }

  if (eventId === EventIdEnum.Issued) {
    await handleConfidentialAssetIssued(blockId, params);
  }

  if (eventId === EventIdEnum.VenueFiltering) {
    await handleVenueFiltering(blockId, params);
  }

  if (eventId === EventIdEnum.VenuesAllowed) {
    await handleVenuesAllowed(blockId, params);
  }

  if (eventId === EventIdEnum.VenuesBlocked) {
    await handleVenuesBlocked(blockId, params);
  }

  if (eventId === EventIdEnum.VenueCreated) {
    await handleVenueCreated(blockId, params);
  }
};
