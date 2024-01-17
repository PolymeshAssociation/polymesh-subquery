import { Codec } from '@polkadot/types/types';
import {
  ConfidentialLeg,
  ConfidentialTransaction,
  ConfidentialTransactionAffirmation,
  EventIdEnum,
  ModuleIdEnum,
  ConfidentialTransactionStatusEnum,
  AffirmingPartyEnum,
  AffirmStatusEnum,
  SenderProof,
  AssetAuditorGroup,
} from '../../types';
import { bytesToString, getNumberValue, getTextValue } from '../util';
import { HandlerArgs } from './common';

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

const handleConfidentialTransactionCreated = async ({
  blockId,
  eventIdx,
  params,
}: HandlerArgs): Promise<void> => {
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

const handleConfidentialTransactionExecutedOrRejected = async (
  args: HandlerArgs
): Promise<void> => {
  const { eventId, params, blockId } = args;

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
  type: AffirmingPartyEnum;
  proofs?: SenderProof[];
};

const getAffirmationTypeAndProofs = (party: Codec): AffirmationsAndAffirmationType => {
  const partyObject = party.toJSON();

  const [typeString] = Object.keys(partyObject);

  let type: AffirmingPartyEnum;

  if (typeString.toLocaleLowerCase() === 'mediator') {
    type = AffirmingPartyEnum.Mediator;
  }
  if (typeString.toLocaleLowerCase() === 'receiver') {
    type = AffirmingPartyEnum.Receiver;
  }
  if (typeString.toLocaleLowerCase() === 'sender') {
    type = AffirmingPartyEnum.Sender;
  }

  if (!type) {
    throw new Error('Could not extract type from affirmation');
  }

  let proofs: SenderProof[];

  if (type === AffirmingPartyEnum.Sender) {
    const proofsObject = partyObject[typeString].proofs;

    proofs = Object.keys(proofsObject).map(assetId => {
      return {
        assetId,
        proof: proofsObject[assetId],
      };
    });
  }

  return { type, proofs };
};

const handleConfidentialTransactionAffirmed = async (
  blockId: string,
  params: Codec[]
): Promise<void> => {
  const [rawDid, rawTransactionId, rawLegId, rawType, rawPendingAffirmations] = params;

  const did = getTextValue(rawDid);
  const transactionId = getTextValue(rawTransactionId);
  const legId = getNumberValue(rawLegId);
  const { type, proofs } = getAffirmationTypeAndProofs(rawType);
  const pendingAffirmations = getNumberValue(rawPendingAffirmations);

  const affirmation = ConfidentialTransactionAffirmation.create({
    id: `${transactionId}/${type}/${did}`,
    transactionId,
    legId,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    identityId: did,
    type,
    status: AffirmStatusEnum.Affirmed,
    proofs,
  });

  const transaction = await ConfidentialTransaction.get(transactionId);

  if (transaction) {
    transaction.pendingAffirmations = pendingAffirmations;

    await Promise.all([transaction.save(), affirmation.save()]);
  }
};

export const mapConfidentialTransaction = async (args: HandlerArgs): Promise<void> => {
  const { blockId, moduleId, eventId, params } = args;

  if (moduleId !== ModuleIdEnum.confidentialasset) {
    return;
  }

  if (eventId === EventIdEnum.TransactionCreated) {
    await handleConfidentialTransactionCreated(args);
  }

  if (eventId === EventIdEnum.TransactionAffirmed) {
    await handleConfidentialTransactionAffirmed(blockId, params);
  }

  if (eventId === EventIdEnum.TransactionRejected || eventId === EventIdEnum.TransactionExecuted) {
    await handleConfidentialTransactionExecutedOrRejected(args);
  }
};
