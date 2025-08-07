import { SubstrateEvent } from '@subql/types';
import { serializeTicker, getTextValue, getDateValue } from '../../../utils';
import { getAsset, extractArgs } from '../common';
import { TickerReservation } from '../../../types';

const getTickerReservation = (ticker: string): Promise<TickerReservation> => {
  return TickerReservation.get(ticker);
};

export const handleTickerRegistered = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const [rawIdentity, rawTicker, rawExpiry] = params;

  const identityId = getTextValue(rawIdentity);
  const ticker = serializeTicker(rawTicker);
  const expiry = rawExpiry ? getDateValue(rawExpiry) : null;

  await TickerReservation.create({
    id: ticker,
    ticker,
    identityId,
    expiry,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const handleTickerLinkedToAsset = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const [, rawTicker, rawAssetId] = params;
  const ticker = serializeTicker(rawTicker);
  const assetId = getTextValue(rawAssetId);
  const [asset, reservation] = await Promise.all([getAsset(assetId), getTickerReservation(ticker)]);

  asset.ticker = ticker;
  asset.updatedBlockId = blockId;
  reservation.updatedBlockId = blockId;
  reservation.assetId = asset.id;

  await Promise.all([asset.save(), reservation.save()]);
};

export const handleTickerUnlinkedFromAsset = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const [, rawTicker, rawAssetId] = params;
  const ticker = serializeTicker(rawTicker);
  const assetId = getTextValue(rawAssetId);
  const [asset, reservation] = await Promise.all([getAsset(assetId), getTickerReservation(ticker)]);

  if (asset.ticker === ticker) {
    asset.ticker = undefined;
    asset.updatedBlockId = blockId;
  }

  reservation.assetId = null;
  reservation.updatedBlockId = blockId;

  await Promise.all([asset.save(), reservation.save()]);
};

export const handleTickerTransferred = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const [rawDid, rawTicker] = params;

  const did = getTextValue(rawDid);
  const ticker = serializeTicker(rawTicker);

  const reservation = await getTickerReservation(ticker);

  reservation.identityId = did;
  reservation.updatedBlockId = blockId;

  await reservation.save();
};
