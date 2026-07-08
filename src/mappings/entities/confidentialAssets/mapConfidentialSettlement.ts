import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import {
  AffirmingPartyEnum,
  ConfidentialAffirmationStatusEnum,
  ConfidentialLeg,
  ConfidentialLegAffirmation,
  ConfidentialSettlement,
  ConfidentialSettlementStatusEnum,
  EventIdEnum,
} from '../../../types';
import { bytesToString, getNumberValue, getTextValue } from '../../../utils';
import { extractArgs } from '../common';

type LegRefDetails = {
  settlementId: string;
  legId: number;
};

/**
 * A `LegRef` is a struct of the settlement reference (hash of the settlement creation proof)
 * and the leg index within the settlement
 */
export const getLegRef = (item: Codec): LegRefDetails => {
  const legRef = item.toJSON() as { settlement: string; legId: number };
  return {
    settlementId: legRef.settlement,
    legId: Number(legRef.legId),
  };
};

/**
 * The legs of a settlement are encrypted. The SCALE encoded hex is stored as is, since the
 * chain prunes the leg data at settlement finalization
 */
export const getEncryptedLegs = (item: Codec): string[] => {
  return Array.from(item as unknown as Iterable<Codec>).map(leg => leg.toHex());
};

export const handleConfidentialSettlementCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);

  const [rawSettlementRef, rawMemo, rawAssetRootBlock, rawLegs] = params;

  const settlementId = getTextValue(rawSettlementRef);
  const encryptedLegs = getEncryptedLegs(rawLegs);

  const settlementPromise = ConfidentialSettlement.create({
    id: settlementId,
    memo: bytesToString(rawMemo),
    assetRootBlock: getNumberValue(rawAssetRootBlock),
    legCount: encryptedLegs.length,
    status: ConfidentialSettlementStatusEnum.Pending,
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();

  const legPromises = encryptedLegs.map((encryptedData, legId) =>
    ConfidentialLeg.create({
      id: `${settlementId}/${legId}`,
      settlementId,
      legId,
      encryptedData,
      createdBlockId: blockId,
      updatedBlockId: blockId,
      createdEventId: blockEventId,
    }).save()
  );

  await Promise.all([settlementPromise, ...legPromises]);
};

export const handleConfidentialSettlementStatusUpdated = async (
  event: SubstrateEvent
): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const [rawSettlementRef, rawStatus] = params;

  const status = getTextValue(rawStatus) as ConfidentialSettlementStatusEnum;

  if (!Object.values(ConfidentialSettlementStatusEnum).includes(status)) {
    throw new Error(`Unknown confidential settlement status: ${status}`);
  }

  const settlement = await ConfidentialSettlement.get(getTextValue(rawSettlementRef));

  if (settlement) {
    settlement.status = status;
    settlement.updatedBlockId = blockId;

    await settlement.save();
  }
};

type PartyStatus = {
  party: AffirmingPartyEnum;
  status: ConfidentialAffirmationStatusEnum;
};

const getPartyStatus = (eventId: EventIdEnum): PartyStatus => {
  switch (eventId) {
    case EventIdEnum.SenderAffirmed:
      return {
        party: AffirmingPartyEnum.Sender,
        status: ConfidentialAffirmationStatusEnum.Affirmed,
      };
    case EventIdEnum.ReceiverAffirmed:
      return {
        party: AffirmingPartyEnum.Receiver,
        status: ConfidentialAffirmationStatusEnum.Affirmed,
      };
    case EventIdEnum.MediatorAffirmed:
      return {
        party: AffirmingPartyEnum.Mediator,
        status: ConfidentialAffirmationStatusEnum.Affirmed,
      };
    case EventIdEnum.MediatorRejected:
      return {
        party: AffirmingPartyEnum.Mediator,
        status: ConfidentialAffirmationStatusEnum.Rejected,
      };
    case EventIdEnum.SenderCounterUpdated:
      return {
        party: AffirmingPartyEnum.Sender,
        status: ConfidentialAffirmationStatusEnum.Finalized,
      };
    case EventIdEnum.ReceiverClaimed:
      return {
        party: AffirmingPartyEnum.Receiver,
        status: ConfidentialAffirmationStatusEnum.Finalized,
      };
    case EventIdEnum.SenderAffirmationReverted:
      return {
        party: AffirmingPartyEnum.Sender,
        status: ConfidentialAffirmationStatusEnum.Reverted,
      };
    case EventIdEnum.ReceiverAffirmationReverted:
      return {
        party: AffirmingPartyEnum.Receiver,
        status: ConfidentialAffirmationStatusEnum.Reverted,
      };
    default:
      throw new Error(`Unhandled confidential leg affirmation event: ${eventId}`);
  }
};

/**
 * Handles all per party leg affirmation events (`SenderAffirmed`, `ReceiverAffirmed`,
 * `MediatorAffirmed`, `MediatorRejected`, `SenderCounterUpdated`, `ReceiverClaimed`,
 * `SenderAffirmationReverted` and `ReceiverAffirmationReverted`), tracking the latest
 * affirmation status of each party for a settlement leg
 */
export const handleConfidentialLegPartyUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventId, eventIdx, blockId, blockEventId } = extractArgs(event);

  const [rawLegRef, rawKeyIndex] = params;

  const { settlementId, legId } = getLegRef(rawLegRef);
  const { party, status } = getPartyStatus(eventId);

  let id = `${settlementId}/${legId}/${party}`;
  let keyIndex: number | undefined;

  if (party === AffirmingPartyEnum.Mediator) {
    keyIndex = getNumberValue(rawKeyIndex);
    id = `${id}/${keyIndex}`;
  }

  const affirmation = await ConfidentialLegAffirmation.get(id);

  if (affirmation) {
    affirmation.status = status;
    affirmation.eventIdx = eventIdx;
    affirmation.updatedBlockId = blockId;

    await affirmation.save();
  } else {
    await ConfidentialLegAffirmation.create({
      id,
      settlementId,
      legId: `${settlementId}/${legId}`,
      party,
      keyIndex,
      status,
      eventIdx,
      createdBlockId: blockId,
      updatedBlockId: blockId,
      createdEventId: blockEventId,
    }).save();
  }
};
