import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { AnomalyKind, TickerReservation } from '../../../types';
import { getDateValue, getTextValue, serializeTicker } from '../../../utils';
import { recordAnomaly } from '../../../utils/anomaly';
import { isPartialIndex } from '../../indexOrigin';
import { extractArgs, getAsset } from '../common';
import { resolveIdentity } from '../identities/mapIdentities';

const getTickerReservation = (ticker: string): Promise<TickerReservation | undefined> => {
  return TickerReservation.get(ticker);
};

/**
 * The reservation of a classic (pre-v6) ticker, created with `identityId` as its holder when the
 * index has none yet. `ClassicTickerClaimed` is not routed to a handler: before 6.0.0
 * `TickerTransferred` was emitted first, so it reserves the ticker from its own values.
 */
const reserveClassicTicker = async (
  ticker: string,
  identityId: string,
  blockEventId: string
): Promise<TickerReservation> => {
  let reservation = await TickerReservation.get(ticker);

  if (!reservation) {
    reservation = TickerReservation.create({
      id: ticker,
      ticker,
      assetId: null,
      identityId,
      createdEventId: blockEventId,
      updatedEventId: blockEventId,
    });
    await reservation.save();
  }

  return reservation;
};

/**
 * The reservation of `ticker`, from the index or, when the index has none, from chain storage
 * (`asset.uniqueTickerRegistration`, from v7). The index lacks one when it started after the ticker
 * was registered. `undefined` when the chain has no registration either, such as after an unlink
 * that removed it; on a genesis replay that is a gap, and recorded.
 */
const reservationOf = async (
  ticker: string,
  rawTicker: Codec,
  event: SubstrateEvent
): Promise<TickerReservation | undefined> => {
  const indexed = await TickerReservation.get(ticker);
  if (indexed) {
    return indexed;
  }

  const { block, blockEventId, eventIdx, moduleId, eventId } = extractArgs(event);
  const registrations = api.query.asset?.uniqueTickerRegistration as unknown as
    | ((ticker: Codec) => Promise<Codec>)
    | undefined;
  const registration = registrations
    ? ((await registrations(rawTicker)).toJSON() as {
        owner?: string;
        expiry?: number | null;
      } | null)
    : null;

  if (registration?.owner) {
    const identityId = await resolveIdentity(registration.owner, {
      reason: 'a ticker registration read from chain storage',
      eventIdx,
      block,
      blockEventId,
    });

    if (identityId) {
      return TickerReservation.create({
        id: ticker,
        ticker,
        identityId,
        expiry: registration.expiry ? new Date(Number(registration.expiry)) : null,
        createdEventId: blockEventId,
        updatedEventId: blockEventId,
      });
    }
  }

  if (!(await isPartialIndex())) {
    await recordAnomaly({
      kind: AnomalyKind.MissingReferencedEntity,
      detail: `TickerReservation ${ticker} is neither indexed nor registered on chain`,
      block,
      eventIdx,
      moduleId,
      eventId,
    });
  }

  return undefined;
};

export const handleTickerRegistered = async (event: SubstrateEvent): Promise<void> => {
  const { blockEventId } = extractArgs(event);
  const { ownerDid: did, ticker: rawTicker, expiry: rawExpiry } = decodeEvent(event);

  const identityId = getTextValue(did);
  const ticker = serializeTicker(rawTicker);
  const expiry = rawExpiry ? getDateValue(rawExpiry) : null;

  const reservation = await getTickerReservation(ticker);

  // this is need to handle case when ticker registered events were re-triggerred in 7.1.0
  if (reservation) {
    reservation.identityId = identityId;
    reservation.expiry = expiry;
    reservation.updatedEventId = blockEventId;
    await reservation.save();
  } else {
    await TickerReservation.create({
      id: ticker,
      ticker,
      identityId,
      expiry,
      createdEventId: blockEventId,
      updatedEventId: blockEventId,
    }).save();
  }
};

export const handleTickerLinkedToAsset = async (event: SubstrateEvent): Promise<void> => {
  const { blockEventId } = extractArgs(event);
  const { ticker: rawTicker, assetId: rawAssetId } = decodeEvent(event);

  const ticker = serializeTicker(rawTicker);
  const assetId = getTextValue(rawAssetId);
  const [asset, reservation] = await Promise.all([
    getAsset(assetId, event),
    reservationOf(ticker, rawTicker, event),
  ]);

  asset.ticker = ticker;
  asset.updatedEventId = blockEventId;

  if (reservation) {
    reservation.assetId = asset.id;
    reservation.updatedEventId = blockEventId;
  }

  await Promise.all([asset.save(), reservation?.save()]);
};

export const handleTickerUnlinkedFromAsset = async (event: SubstrateEvent): Promise<void> => {
  const { blockEventId } = extractArgs(event);
  const { ticker: rawTicker, assetId: rawAssetId } = decodeEvent(event);

  const ticker = serializeTicker(rawTicker);
  const assetId = getTextValue(rawAssetId);
  // Only the index's own reservation: an unlink can remove the registration, so chain storage may
  // no longer hold one, and a reservation the index never had has nothing to unlink.
  const [asset, reservation] = await Promise.all([
    getAsset(assetId, event),
    getTickerReservation(ticker),
  ]);

  if (asset.ticker === ticker) {
    asset.ticker = undefined;
    asset.updatedEventId = blockEventId;
  }

  if (reservation) {
    reservation.assetId = null;
    reservation.updatedEventId = blockEventId;
  }

  await Promise.all([asset.save(), reservation?.save()]);
};

export const handleTickerTransferred = async (event: SubstrateEvent): Promise<void> => {
  const { blockEventId } = extractArgs(event);
  const { newOwnerDid: rawDid, ticker: rawTicker } = decodeEvent(event);

  const did = getTextValue(rawDid);
  const ticker = serializeTicker(rawTicker);

  let reservation = await getTickerReservation(ticker);

  // before 6.0.0 TickerTransferred was emitted before ClassicTickerClaimed
  if (!reservation) {
    reservation = await reserveClassicTicker(ticker, did, blockEventId);
  }

  reservation.identityId = did;
  reservation.updatedEventId = blockEventId;

  await reservation.save();
};
