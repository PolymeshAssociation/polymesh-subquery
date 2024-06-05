import { Codec } from '@polkadot/types/types';
import {
  ConfidentialLeg,
  ConfidentialTransaction,
  ConfidentialTransactionAffirmation,
  EventIdEnum,
  ConfidentialTransactionStatusEnum,
  AffirmingPartyEnum,
  AffirmStatusEnum,
  SenderProof,
  AssetAuditorGroup,
} from '../../types';
import { bytesToString, getNumberValue, getTextValue } from '../util';
import { extractArgs } from './common';
import { SubstrateEvent } from '@subql/types';

type ConfidentialLegDetails = {
  mediators: string[];
  sender: string;
  receiver: string;
  assetAuditors: AssetAuditorGroup[];
};

export const getConfidentialLegs = (item: Codec): ConfidentialLegDetails[] => {
  const legs = JSON.parse(item.toString());

  return legs.map(leg => {
    const { auditors: assetAuditorsPair, mediators, sender, receiver } = leg;

    const assetAuditors: AssetAuditorGroup[] = [];

    Object.keys(assetAuditorsPair).forEach(assetId => {
      assetAuditors.push({
        assetId,
        auditors: assetAuditorsPair[assetId],
      });
    });

    return { assetAuditors, mediators, sender, receiver };
  });
};

const getPendingAffirmationCountFromLegs = (legs: ConfidentialLegDetails[]): number => {
  return legs.reduce((acc, leg) => acc + leg.mediators.length + 2, 0); // +2 for sender and receiver
};

export const handleConfidentialTransactionCreated = async (
  event: SubstrateEvent
): Promise<void> => {
  const { params, eventIdx, blockId } = extractArgs(event);
  const [, rawVenueId, rawTransactionId, rawLegs, rawMemo] = params;

  const venueId = getTextValue(rawVenueId);
  const transactionId = getTextValue(rawTransactionId);
  const legs = getConfidentialLegs(rawLegs);
  const memo = bytesToString(rawMemo);

  const transactionPromise = ConfidentialTransaction.create({
    id: transactionId,
    venueId,
    status: ConfidentialTransactionStatusEnum.Created,
    eventId: EventIdEnum.TransactionCreated,
    eventIdx,
    pendingAffirmations: getPendingAffirmationCountFromLegs(legs),
    memo,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();

  const legPromises = legs.map(async (leg, index) => {
    const { assetAuditors, mediators, sender, receiver } = leg;

    return ConfidentialLeg.create({
      id: `${transactionId}/${index}`,
      transactionId,
      assetAuditors,
      mediators,
      senderId: sender,
      receiverId: receiver,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  });

  await Promise.all([transactionPromise, ...legPromises]);
};

export const handleConfidentialTransactionExecutedOrRejected = async (
  event: SubstrateEvent
): Promise<void> => {
  const { eventId, params, blockId } = extractArgs(event);

  const [, rawTransactionId, rawMemo] = params;

  const transactionId = getTextValue(rawTransactionId);
  const memo = bytesToString(rawMemo);

  const transaction = await ConfidentialTransaction.get(transactionId);

  if (transaction) {
    transaction.status =
      eventId === EventIdEnum.TransactionExecuted
        ? ConfidentialTransactionStatusEnum.Executed
        : ConfidentialTransactionStatusEnum.Rejected;
    transaction.updatedBlockId = blockId;
    transaction.memo = memo;

    await transaction.save();
  }
};

type AffirmationsAndAffirmationType = {
  party: AffirmingPartyEnum;
  proofs?: SenderProof[];
};

const getAffirmationTypeAndProofs = (rawParty: Codec): AffirmationsAndAffirmationType => {
  const partyObject = rawParty.toJSON();

  const [typeString] = Object.keys(partyObject);

  let party: AffirmingPartyEnum;

  if (typeString.toLocaleLowerCase() === 'mediator') {
    party = AffirmingPartyEnum.Mediator;
  }
  if (typeString.toLocaleLowerCase() === 'receiver') {
    party = AffirmingPartyEnum.Receiver;
  }
  if (typeString.toLocaleLowerCase() === 'sender') {
    party = AffirmingPartyEnum.Sender;
  }

  if (!party) {
    throw new Error('Could not extract party from affirmation');
  }

  let proofs: SenderProof[];

  if (party === AffirmingPartyEnum.Sender) {
    const proofsObject = partyObject[typeString].proofs;

    proofs = Object.keys(proofsObject).map(assetId => {
      return {
        assetId,
        proof: proofsObject[assetId],
      };
    });
  }

  return { party, proofs };
};

export const handleConfidentialTransactionAffirmed = async (
  event: SubstrateEvent
): Promise<void> => {
  const { params, eventIdx, blockId } = extractArgs(event);
  const [rawDid, rawTransactionId, rawLegId, rawParty, rawPendingAffirmations] = params;

  const did = getTextValue(rawDid);
  const transactionId = getTextValue(rawTransactionId);
  const legId = getNumberValue(rawLegId);
  const { party, proofs } = getAffirmationTypeAndProofs(rawParty);
  const pendingAffirmations = getNumberValue(rawPendingAffirmations);

  const affirmation = ConfidentialTransactionAffirmation.create({
    id: `${transactionId}/${party}/${did}`,
    transactionId,
    legId,
    identityId: did,
    party,
    status: AffirmStatusEnum.Affirmed,
    proofs,
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  });

  const transaction = await ConfidentialTransaction.get(transactionId);

  if (transaction) {
    transaction.pendingAffirmations = pendingAffirmations;

    await Promise.all([transaction.save(), affirmation.save()]);
  }
};
