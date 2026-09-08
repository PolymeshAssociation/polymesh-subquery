import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { Venue } from '../../../types';
import {
  addIfNotIncludes,
  bytesToString,
  getBooleanValue,
  getTextValue,
  removeIfIncludes,
} from '../../../utils';
import { extractArgs } from '../common';

/**
 * Extracts venue signer addresses from the raw `VenueSignersUpdated` event param.
 *
 * From chain 8.0.0, `signers` is emitted as a `BTreeSet<AccountId>` (a native `Set`, which has
 * no `.map`) instead of the `Vec<AccountId>` used until 7.x (array-like, has `.map`).
 * `Array.from` accepts both iterables uniformly.
 */
export const extractVenueSigners = (rawSigners: Iterable<Codec>): string[] =>
  Array.from(rawSigners).map(signer => signer.toString());

const getVenue = async (venueId: string): Promise<Venue> => {
  const venue = await Venue.get(venueId);

  if (!venue) {
    throw new Error(`Venue with id ${venueId} was not found`);
  }

  return venue;
};

export const handleVenueCreated = async (event: SubstrateEvent): Promise<void> => {
  const { blockId } = extractArgs(event);
  const { did, venueId, details, venueType } = decodeEvent(event);

  await Venue.create({
    id: getTextValue(venueId),
    ownerId: getTextValue(did),
    details: bytesToString(details),
    type: getTextValue(venueType),
    signers: [],
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const handleVenueDetailsUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { blockId } = extractArgs(event);
  const { venueId, details } = decodeEvent(event);

  const venue = await getVenue(getTextValue(venueId));

  venue.details = bytesToString(details);
  venue.updatedBlockId = blockId;

  await venue.save();
};

export const handleVenueTypeUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { blockId } = extractArgs(event);
  const { venueId, venueType } = decodeEvent(event);

  const venue = await getVenue(getTextValue(venueId));

  venue.type = getTextValue(venueType);
  venue.updatedBlockId = blockId;

  await venue.save();
};

export const handleVenueSignersUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { blockId } = extractArgs(event);
  const { venueId, signers: rawSigners, updateType: rawUpdateType } = decodeEvent(event);

  const signers = extractVenueSigners(rawSigners as unknown as Iterable<Codec>);

  const venue = await getVenue(getTextValue(venueId));

  const updateType = getBooleanValue(rawUpdateType);

  if (updateType) {
    signers.map(signer => addIfNotIncludes(venue.signers, signer));
  } else {
    signers.map(signer => removeIfIncludes(venue.signers, signer));
  }

  venue.updatedBlockId = blockId;

  await venue.save();
};
