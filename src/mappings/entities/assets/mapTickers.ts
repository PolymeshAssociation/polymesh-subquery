import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { TickerReservation } from '../../../types';
import { getDateValue, getTextValue, serializeTicker } from '../../../utils';
import { extractArgs, getAsset } from '../common';

const getTickerReservation = (ticker: string): Promise<TickerReservation> => {
  return TickerReservation.get(ticker);
};

/**
 * Also reached from `handleTickerTransferred`, which passes its own event: before 6.0.0
 * `TickerTransferred` was emitted first, so the reservation does not exist yet. Both events name
 * their first two parameters `did` and `ticker`, so the decode is correct either way.
 */
export const handleClassicTickerClaimed = async (
  event: SubstrateEvent
): Promise<TickerReservation> => {
  const { blockId } = extractArgs(event);
  const { did, ticker: rawTicker } = decodeEvent(event);

  const identityId = getTextValue(did);
  const ticker = serializeTicker(rawTicker);

  let reservation = await TickerReservation.get(ticker);

  if (!reservation) {
    reservation = TickerReservation.create({
      id: ticker,
      ticker,
      assetId: null,
      identityId,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    });
    await reservation.save();
  }

  return reservation;
};

export const handleTickerRegistered = async (event: SubstrateEvent): Promise<void> => {
  const { blockId } = extractArgs(event);
  const { did, ticker: rawTicker, expiry: rawExpiry } = decodeEvent(event);

  const identityId = getTextValue(did);
  const ticker = serializeTicker(rawTicker);
  const expiry = rawExpiry ? getDateValue(rawExpiry) : null;

  const reservation = await getTickerReservation(ticker);

  // this is need to handle case when ticker registered events were re-triggerred in 7.1.0
  if (reservation) {
    reservation.identityId = identityId;
    reservation.expiry = expiry;
    reservation.updatedBlockId = blockId;
    await reservation.save();
  } else {
    await TickerReservation.create({
      id: ticker,
      ticker,
      identityId,
      expiry,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  }
};

export const handleTickerLinkedToAsset = async (event: SubstrateEvent): Promise<void> => {
  const { blockId } = extractArgs(event);
  const { ticker: rawTicker, assetId: rawAssetId } = decodeEvent(event);

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
  const { blockId } = extractArgs(event);
  const { ticker: rawTicker, assetId: rawAssetId } = decodeEvent(event);

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
  const { blockId } = extractArgs(event);
  const { did: rawDid, ticker: rawTicker } = decodeEvent(event);

  const did = getTextValue(rawDid);
  const ticker = serializeTicker(rawTicker);

  let reservation = await getTickerReservation(ticker);

  // before 6.0.0 TickerTransferred was emitted before ClassicTickerClaimed
  if (!reservation) {
    reservation = await handleClassicTickerClaimed(event);
  }

  reservation.identityId = did;
  reservation.updatedBlockId = blockId;

  await reservation.save();
};
