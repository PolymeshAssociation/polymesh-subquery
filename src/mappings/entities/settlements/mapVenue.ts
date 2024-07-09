import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { Venue } from '../../../types';
import {
  addIfNotIncludes,
  bytesToString,
  getBooleanValue,
  getTextValue,
  removeIfIncludes,
} from '../../../utils';
import { extractArgs } from '../common';

const getVenue = async (venueId: string): Promise<Venue> => {
  const venue = await Venue.get(venueId);

  if (!venue) {
    throw new Error(`Venue with id ${venueId} was not found`);
  }

  return venue;
};

export const handleVenueCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [rawIdentity, rawVenueId, rawDetails, rawType] = params;

  await Venue.create({
    id: getTextValue(rawVenueId),
    ownerId: getTextValue(rawIdentity),
    details: bytesToString(rawDetails),
    type: getTextValue(rawType),
    signers: [],
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const handleVenueDetailsUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawVenueId, rawDetails] = params;

  const id = getTextValue(rawVenueId);
  const venue = await getVenue(id);

  venue.details = bytesToString(rawDetails);
  venue.updatedBlockId = blockId;

  await venue.save();
};

export const handleVenueTypeUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawVenueId, rawType] = params;

  const id = getTextValue(rawVenueId);
  const venue = await getVenue(id);

  venue.type = getTextValue(rawType);
  venue.updatedBlockId = blockId;

  await venue.save();
};

export const handleVenueSignersUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawVenueId, rawSigners, rawUpdateType] = params;

  const signers = (rawSigners as unknown as Codec[]).map(signer => signer.toString());

  const id = getTextValue(rawVenueId);
  const venue = await getVenue(id);

  const updateType = getBooleanValue(rawUpdateType);

  if (updateType) {
    signers.map(signer => addIfNotIncludes(venue.signers, signer));
  } else {
    signers.map(signer => removeIfIncludes(venue.signers, signer));
  }

  venue.updatedBlockId = blockId;

  await venue.save();
};
