import { Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { AnomalyKind, Instruction, InstructionEvent, Leg } from '../../../types';
import {
  addIfNotIncludes,
  getDateValue,
  getErrorDetails,
  getLegsValue,
  getNumberValue,
  getSettlementLeg,
  getSettlementTypeDetails,
  getSignerAddress,
  getStringArrayValue,
  getTextValue,
  is7xChain,
  padNumericId,
  rawAssetHolderToAssetHolder,
  specVersionOf,
} from '../../../utils';
import { recordAnomaly } from '../../../utils/anomaly';
import {
  getPartyId,
  isResolved,
  pendingHolderAffirmation,
  pendingMediatorAffirmation,
  setHolderAffirmation,
  setMediatorAffirmation,
} from './holderAffirmations';
import { applySilentPreApprovals, preApprovesSilently } from './silentPreApprovals';
import { getLegV2Values } from '../../../utils/legV2';
import { extractArgs, HandlerArgs } from '../common';
import {
  createPortfolioIfNotExists,
  applyMoveWithinIdentity,
  mapAssetMovement,
} from '../identities/mapPortfolio';
import {
  AffirmStatusEnum,
  EventIdEnum,
  InstructionEventEnum,
  InstructionStatusEnum,
} from './../../../types/enums';
import { InstructionAffirmation } from './../../../types/models/InstructionAffirmation';
import { InstructionParty } from './../../../types/models/InstructionParty';
import { OffChainReceipt } from './../../../types/models/OffChainReceipt';
import {
  getPortfolioOrAccount,
  HolderRef,
  holderAffirmationId,
  holdersOfLegs,
  instructionPartiesOf,
  mediatorAffirmationId,
  LegDetails,
  PartyDetails,
  portfolioNumber,
} from './../../../utils/settlements';
import { memoText } from '../../../utils/text';

/**
 * The `InstructionEvent.event` value for each event that writes one.
 *
 * The narrow enum exists so the column cannot hold an event that has nothing to do with an
 * instruction; casting an `EventIdEnum` straight into it gives that up and would write a value
 * the GraphQL enum never declared. An event arriving here that this map does not cover is drift
 * between the handler list and the enum, so it is reported rather than written.
 */
const instructionEventMap: Partial<Record<EventIdEnum, InstructionEventEnum>> = {
  [EventIdEnum.InstructionExecuted]: InstructionEventEnum.InstructionExecuted,
  [EventIdEnum.InstructionFailed]: InstructionEventEnum.InstructionFailed,
  [EventIdEnum.InstructionLocked]: InstructionEventEnum.InstructionLocked,
  [EventIdEnum.InstructionUnlocked]: InstructionEventEnum.InstructionUnlocked,
  [EventIdEnum.FailedToExecuteInstruction]: InstructionEventEnum.FailedToExecuteInstruction,
};

const instructionEventFor = async (
  eventId: EventIdEnum,
  block: SubstrateBlock,
  eventIdx: number
): Promise<InstructionEventEnum | undefined> => {
  const mapped = instructionEventMap[eventId];

  if (!mapped) {
    await recordAnomaly({
      kind: AnomalyKind.UnknownEnumValue,
      detail: `${eventId} writes an InstructionEvent but has no InstructionEventEnum value`,
      block,
      eventIdx,
      dedupeKey: `instructionEvent/${eventId}`,
    });
  }

  return mapped;
};

const instructionStatusMap = {
  [EventIdEnum.InstructionExecuted]: InstructionStatusEnum.Executed,
  [EventIdEnum.InstructionRejected]: InstructionStatusEnum.Rejected,
  [EventIdEnum.InstructionFailed]: InstructionStatusEnum.Failed,
  [EventIdEnum.InstructionCreated]: InstructionStatusEnum.Created,
  [EventIdEnum.FailedToExecuteInstruction]: InstructionStatusEnum.Failed,
  [EventIdEnum.InstructionLocked]: InstructionStatusEnum.Locked,
  /**
   * unlocking returns the instruction to `Pending`, which the schema represents with the same
   * `Created` status used when the instruction was first created
   */
  [EventIdEnum.InstructionUnlocked]: InstructionStatusEnum.Created,
};

/**
 * Sets up required entities for a leg and returns params that can be batched for a bulk inserted
 */
const prepareLegCreateParams = async (
  blockId: string,
  instructionId: string,
  address: string | undefined,
  legDetails: LegDetails,
  { eventIdx, eventId, block, blockEventId }: HandlerArgs
): Promise<Parameters<typeof Leg.create>[0]> => {
  const { fromId: from, fromPortfolioId, toId: to, toPortfolioId, legIndex } = legDetails;
  // the default portfolio (number 0) always exists
  const fromPortfolio = fromPortfolioId ? portfolioNumber(fromPortfolioId) : undefined;
  const toPortfolio = toPortfolioId ? portfolioNumber(toPortfolioId) : undefined;
  const promises = [];

  /**
   * older versions did not ensure the existence of sender and receivers, so entries may need to be added
   */
  if (is7xChain(block)) {
    if (fromPortfolio && from) {
      promises.push(
        createPortfolioIfNotExists(
          { identityId: from, number: fromPortfolio },
          blockId,
          eventId,
          eventIdx,
          block,
          blockEventId
        )
      );
    }
    if (toPortfolio && to) {
      promises.push(
        createPortfolioIfNotExists(
          { identityId: to, number: toPortfolio },
          blockId,
          eventId,
          eventIdx,
          block,
          blockEventId
        )
      );
    }

    await Promise.all(promises);
  }

  return {
    id: `${instructionId}/${legIndex}`,
    ...legDetails,
    instructionId,
    addresses: address ? [address] : [],
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  };
};

/**
 * Adds the signer of an affirmation or execution to every leg of `instruction`.
 *
 * Nothing to add on the scheduled and unsigned execution paths, which `getSignerAddress` returns
 * no address for. The legs are read by id, all at once: a leg's id is `instructionId/legIndex`,
 * the indices run from 0 with no gaps (`getLegsValue`, `getSettlementLeg`), and the instruction
 * records how many there are.
 */
export const updateLegs = async (
  {
    blockEventId,
    block,
    eventIdx,
  }: { blockEventId: string; block: SubstrateBlock; eventIdx: number },
  address: string | undefined,
  instruction: Pick<Instruction, 'id' | 'legCount'>
): Promise<void> => {
  if (!address) {
    return;
  }

  const read = await Promise.all(
    Array.from({ length: instruction.legCount }, (_, legIndex) =>
      Leg.get(`${instruction.id}/${legIndex}`)
    )
  );
  const legs = read.filter((leg): leg is Leg => leg !== undefined);

  if (legs.length < instruction.legCount) {
    // every instruction has its legs, written when it was created: the index is missing some
    await recordAnomaly({
      kind: AnomalyKind.MissingReferencedEntity,
      detail: `instruction ${instruction.id} has ${legs.length} of its ${instruction.legCount} legs in the index to add its signer ${address} to`,
      block,
      eventIdx,
    });
  }

  legs.forEach(leg => {
    addIfNotIncludes(leg.addresses, address);
    leg.updatedEventId = blockEventId;
  });

  if (legs.length > 0) {
    await store.bulkUpdate('Leg', legs);
  }
};

/**
 * The chain's instruction id is a bare numeric sequence. Zero-pad it so
 * `Instruction.id` and every FK that references it (`Leg`, `InstructionParty`,
 * `InstructionAffirmation`, `InstructionEvent`, `AssetTransaction.instructionId`) sort
 * numerically under `ID_DESC`. Every construction and every lookup routes through here.
 */
export const processInstructionId = (id: Codec): string => {
  return padNumericId(getTextValue(id));
};

const getInstruction = async (instructionId: string): Promise<Instruction> => {
  const instruction = await Instruction.get(instructionId);

  if (!instruction) {
    throw new Error(`could not find instruction by id: ${instructionId}`);
  }

  return instruction;
};

const createInstructionParty = async (
  instructionId: string,
  blockEventId: string,
  parties: Map<string, PartyDetails>,
  isMediator: boolean
): Promise<void> => {
  await Promise.all(
    [...parties.values()].map(({ identityId }) =>
      InstructionParty.create({
        id: getPartyId(instructionId, identityId, isMediator),
        instructionId,
        isMediator,
        identityId,
        createdEventId: blockEventId,
        updatedEventId: blockEventId,
      }).save()
    )
  );
};

/**
 * Maps the event 'settlement.InstructionCreated'
 */
export const handleInstructionCreated = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const { blockId, block, extrinsic, blockEventId } = args;
  const address = getSignerAddress(extrinsic);

  const {
    callerDid: rawCreator,
    venueId: rawVenueId,
    instructionId: rawInstructionId,
    settlementType: rawSettlementType,
    tradeDate: rawTradeDate,
    valueDate: rawValueDate,
    legs: rawLegs,
    memo: rawOptMemo,
  } = decodeEvent(event);

  const creator = getTextValue(rawCreator);

  let legs: LegDetails[];

  const typeDetails = getSettlementTypeDetails(rawSettlementType);

  /**
   * Events from 6.0.0 chain were updated to support NFT and OffChain instructions
   *
   * NOTE - For Polymesh private, the spec version starts from 1.0.0
   */
  /**
   * Events from 6.0.0 were updated to support NFT and OffChain instructions. The parameter
   * count did not change, so this is a payload branch rather than a positional one
   */
  if (specVersionOf(block) >= 6_000_000) {
    legs = await getSettlementLeg(rawLegs, block, blockId, blockEventId);
  } else if (args.eventId === EventIdEnum.InstructionV2Created) {
    legs = await getLegV2Values(rawLegs, block);
  } else {
    legs = await getLegsValue(rawLegs, block);
  }

  const instructionId = processInstructionId(rawInstructionId);
  const memo = memoText(rawOptMemo);

  const instruction = Instruction.create({
    id: instructionId,
    status: InstructionStatusEnum.Created,
    venueId: padNumericId(getTextValue(rawVenueId)),
    ...typeDetails,
    tradeDate: getDateValue(rawTradeDate),
    valueDate: getDateValue(rawValueDate),
    memo,
    mediators: [],
    legCount: legs.length,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  });
  await instruction.save();

  const legParams = await Promise.all(
    legs.map(legDetails =>
      prepareLegCreateParams(blockId, instructionId, address, legDetails, args)
    )
  );

  const parties = instructionPartiesOf(legParams);

  const instructionCreatedEvent = InstructionEvent.create({
    id: blockEventId,
    instructionId,
    event: InstructionEventEnum.InstructionCreated,
    identityId: creator,
    signerId: address,
    createdEventId: blockEventId,
  });

  // every holder on a leg starts pending, as the chain records it, except one an earlier event
  // in the block already auto-affirmed (runtimes 6.1.0 to 6.3.0 emit those before this event)
  const autoAffirmedEarlier = autoAffirmedBefore(block, args.eventIdx, instructionId);
  const holders = holdersOfLegs(legParams);
  await Promise.all(
    holders
      .filter(holder => !isResolved(holder))
      .map(({ accountId }) =>
        recordUnresolvedHolder(args, instructionId, accountId, 'its approval is not recorded')
      )
  );
  const affirmations = await Promise.all(
    holders
      .filter(isResolved)
      .map(
        async holder =>
          (autoAffirmedEarlier &&
            (await InstructionAffirmation.get(holderAffirmationId(instructionId, holder)))) ||
          pendingHolderAffirmation(instructionId, holder, blockEventId)
      )
  );

  if (preApprovesSilently(api.runtimeVersion.specName.toString(), block.specVersion)) {
    await applySilentPreApprovals(affirmations, {
      block,
      eventIdx: args.eventIdx,
      instructionId,
      legs: legParams,
      creatorDid: creator,
      signerId: address,
      blockEventId,
    });
  }

  await Promise.all([
    store.bulkCreate('Leg', legParams),
    store.bulkCreate('InstructionAffirmation', affirmations),
    createInstructionParty(instructionId, blockEventId, parties, false),
    instructionCreatedEvent.save(),
  ]);
};

/** Whether an event before `eventIdx` in the block auto-affirmed a holder of `instructionId`. */
const autoAffirmedBefore = (
  block: SubstrateBlock,
  eventIdx: number,
  instructionId: string
): boolean =>
  block.events
    .slice(0, eventIdx)
    .some(
      ({ event }) =>
        event.section === 'settlement' &&
        event.method === EventIdEnum.InstructionAutomaticallyAffirmed &&
        processInstructionId(event.data[2]) === instructionId
    );

/**
 * Reports an account holder the index has no identity for, which the chain requires of every
 * holder, so no party or approval can be recorded for it.
 */
const recordUnresolvedHolder = (
  { block, eventIdx }: HandlerArgs,
  instructionId: string,
  accountId: string | undefined,
  consequence: string
): Promise<void> =>
  recordAnomaly({
    kind: AnomalyKind.MissingReferencedEntity,
    detail: `instruction ${instructionId}'s holder ${accountId} has no identity in the index, though the chain requires one, so ${consequence}`,
    block,
    eventIdx,
  });

/** The holder an affirm, auto-affirm or withdraw event names. */
const eventHolder = async (
  rawHolder: Codec,
  { block, blockId, blockEventId }: HandlerArgs
): Promise<HolderRef> => {
  const { identityId, accountId, portfolioId } = await getPortfolioOrAccount(
    rawHolder,
    block,
    blockId,
    blockEventId
  );
  return { identityId, accountId, portfolioId };
};

/** Records an affirm, auto-affirm or withdraw event on its holder's row and in the events. */
const recordHolderEvent = async (
  event: SubstrateEvent,
  instructionEvent: InstructionEventEnum,
  status: AffirmStatusEnum,
  isAutomaticallyAffirmed: boolean
): Promise<void> => {
  const args = extractArgs(event);
  const { extrinsic, block, blockEventId, eventIdx } = args;
  const signerId = getSignerAddress(extrinsic);
  const {
    callerDid: rawCaller,
    holder: rawHolder,
    instructionId: rawInstructionId,
  } = decodeEvent(event);

  const instructionId = processInstructionId(rawInstructionId);
  const holder = await eventHolder(rawHolder, args);
  const callerDid = getTextValue(rawCaller);

  const affirmation = await setHolderAffirmation(instructionId, holder, {
    status,
    isAutomaticallyAffirmed,
    affirmedById: callerDid,
    signerId,
    blockEventId,
  });

  const writes = [
    affirmation
      ? affirmation.save()
      : recordUnresolvedHolder(
          args,
          instructionId,
          holder.accountId,
          `its ${instructionEvent} is not recorded on an approval`
        ),
    InstructionEvent.create({
      id: blockEventId,
      instructionId,
      event: instructionEvent,
      identityId: callerDid,
      accountId: holder.accountId,
      portfolioId: holder.portfolioId,
      signerId,
      createdEventId: blockEventId,
    }).save(),
  ];
  if (status === AffirmStatusEnum.Affirmed && !isAutomaticallyAffirmed) {
    writes.push(addSignerToLegs({ blockEventId, block, eventIdx }, signerId, instructionId));
  }

  await Promise.all(writes);
};

/**
 * Maps the event - `settlement.InstructionAffirmed`
 */
export const handleInstructionUpdate = (event: SubstrateEvent): Promise<void> =>
  recordHolderEvent(
    event,
    InstructionEventEnum.InstructionAffirmed,
    AffirmStatusEnum.Affirmed,
    false
  );

/** `updateLegs` for an event that names only the instruction, which is read for its leg count. */
const addSignerToLegs = async (
  at: Parameters<typeof updateLegs>[0],
  address: string | undefined,
  instructionId: string
): Promise<void> => {
  if (!address) {
    return;
  }

  const instruction = await Instruction.get(instructionId);

  if (!instruction) {
    await recordAnomaly({
      kind: AnomalyKind.MissingReferencedEntity,
      detail: `instruction ${instructionId} is not in the index to add its signer ${address} to its legs`,
      block: at.block,
      eventIdx: at.eventIdx,
    });
    return;
  }

  await updateLegs(at, address, instruction);
};

/**
 * Maps the event - `settlement.AffirmationWithdrawn`
 */
export const handleAffirmationWithdrawn = (event: SubstrateEvent): Promise<void> =>
  recordHolderEvent(
    event,
    InstructionEventEnum.AffirmationWithdrawn,
    AffirmStatusEnum.Pending,
    false
  );

/**
 * Maps the event - `settlement.InstructionAutomaticallyAffirmed`, which runtimes 6.1.0 to 6.3.0
 * emit before the instruction's creation; the creation keeps the row it writes.
 */
export const handleAutomaticAffirmation = (event: SubstrateEvent): Promise<void> =>
  recordHolderEvent(
    event,
    InstructionEventEnum.InstructionAutomaticallyAffirmed,
    AffirmStatusEnum.Affirmed,
    true
  );

/**
 * Maps the event - `settlement.InstructionRejected`
 */
export const handleInstructionRejected = async (event: SubstrateEvent): Promise<void> => {
  const { extrinsic, blockEventId } = extractArgs(event);
  const { callerDid: rawCaller, instructionId: rawInstructionId } = decodeEvent(event);

  const callerDid = getTextValue(rawCaller);
  const signerId = getSignerAddress(extrinsic);
  const instructionId = processInstructionId(rawInstructionId);

  // rejecting is a fact about the instruction, not any holder's approval, which keeps its state
  const instruction = await getInstruction(instructionId);
  instruction.status = InstructionStatusEnum.Rejected;
  instruction.rejectedById = callerDid;
  instruction.rejectedBySignerId = signerId;
  instruction.updatedEventId = blockEventId;

  await Promise.all([
    instruction.save(),
    InstructionEvent.create({
      id: blockEventId,
      instructionId,
      event: InstructionEventEnum.InstructionRejected,
      identityId: callerDid,
      signerId,
      createdEventId: blockEventId,
    }).save(),
  ]);
};

/**
 * Maps events -
 *   - settlement.InstructionExecuted
 *   - settlement.InstructionFailed
 *   - settlement.InstructionLocked
 *   - settlement.InstructionUnlocked
 */
export const handleInstructionFinalizedEvent = async (event: SubstrateEvent): Promise<void> => {
  const { extrinsic, eventId, blockEventId, block, eventIdx } = extractArgs(event);
  const { callerDid: rawCaller, instructionId: rawInstructionId } = decodeEvent(event);

  const address = getSignerAddress(extrinsic);
  const instructionId = processInstructionId(rawInstructionId);
  const instruction = await getInstruction(instructionId);

  instruction.status = instructionStatusMap[eventId];
  instruction.updatedEventId = blockEventId;

  const instructionEvent = await instructionEventFor(eventId, block, eventIdx);

  const writes = [
    instruction.save(),
    updateLegs({ blockEventId, block, eventIdx }, address, instruction),
  ];

  if (instructionEvent) {
    writes.push(
      InstructionEvent.create({
        id: blockEventId,
        instructionId,
        event: instructionEvent,
        identityId: getTextValue(rawCaller),
        signerId: address,
        createdEventId: blockEventId,
      }).save()
    );
  }

  await Promise.all(writes);
};

/**
 * Maps the event - `settlement.SettlementManuallyExecuted`
 */
export const handleSettlementManuallyExecuted = async (event: SubstrateEvent): Promise<void> => {
  const { extrinsic, blockEventId } = extractArgs(event);
  const { callerDid: rawIdentityId, instructionId: rawInstructionId } = decodeEvent(event);

  const manuallyExecutedEvent = InstructionEvent.create({
    id: blockEventId,
    instructionId: processInstructionId(rawInstructionId),
    event: InstructionEventEnum.SettlementManuallyExecuted,
    identityId: getTextValue(rawIdentityId),
    signerId: getSignerAddress(extrinsic),
    createdEventId: blockEventId,
  });

  await manuallyExecutedEvent.save();
};

/**
 * Maps the event `settlement.FailedToExecuteInstruction`
 */
export const handleFailedToExecuteInstruction = async (event: SubstrateEvent): Promise<void> => {
  const { eventId, blockEventId, block, eventIdx } = extractArgs(event);
  const { instructionId: rawInstructionId, error: rawDispatchError } = decodeEvent(event);

  const instructionId = processInstructionId(rawInstructionId);
  const instruction = await getInstruction(instructionId);

  const failureReason = getErrorDetails(rawDispatchError);

  instruction.updatedEventId = blockEventId;
  instruction.status = InstructionStatusEnum.Failed;
  instruction.failureReason = failureReason;

  const instructionEvent = await instructionEventFor(eventId, block, eventIdx);

  const writes = [instruction.save()];

  if (instructionEvent) {
    writes.push(
      InstructionEvent.create({
        id: blockEventId,
        instructionId,
        event: instructionEvent,
        failureReason,
        createdEventId: blockEventId,
      }).save()
    );
  }

  await Promise.all(writes);
};

interface MediatorChange {
  instructionEvent: InstructionEventEnum;
  status: AffirmStatusEnum;
  rawMediator: Codec;
  rawInstructionId: Codec;
  expiry?: Date;
}

/** Records a mediator's affirmation or withdrawal on the mediator's row and in the events. */
const recordMediatorEvent = async (
  event: SubstrateEvent,
  { instructionEvent, status, rawMediator, rawInstructionId, expiry }: MediatorChange
): Promise<void> => {
  const { extrinsic, blockEventId } = extractArgs(event);
  const signerId = getSignerAddress(extrinsic);

  const mediator = getTextValue(rawMediator);
  const instructionId = processInstructionId(rawInstructionId);

  const affirmation = await setMediatorAffirmation(instructionId, mediator, {
    status,
    affirmedById: mediator,
    signerId,
    blockEventId,
    expiry,
  });

  await Promise.all([
    affirmation.save(),
    InstructionEvent.create({
      id: blockEventId,
      instructionId,
      event: instructionEvent,
      identityId: mediator,
      signerId,
      createdEventId: blockEventId,
    }).save(),
  ]);
};

export const handleMediatorAffirmationReceived = (event: SubstrateEvent): Promise<void> => {
  const { mediatorDid, instructionId, expiry } = decodeEvent(event);
  return recordMediatorEvent(event, {
    instructionEvent: InstructionEventEnum.MediatorAffirmationReceived,
    status: AffirmStatusEnum.Affirmed,
    rawMediator: mediatorDid,
    rawInstructionId: instructionId,
    expiry: getDateValue(expiry),
  });
};

export const handleMediatorAffirmationWithdrawn = (event: SubstrateEvent): Promise<void> => {
  const { mediatorDid, instructionId } = decodeEvent(event);
  return recordMediatorEvent(event, {
    instructionEvent: InstructionEventEnum.MediatorAffirmationWithdrawn,
    status: AffirmStatusEnum.Pending,
    rawMediator: mediatorDid,
    rawInstructionId: instructionId,
  });
};

/**
 * Maps the event - `settlement.InstructionMediators`
 */
export const handleInstructionMediators = async (event: SubstrateEvent): Promise<void> => {
  const { extrinsic, blockEventId } = extractArgs(event);
  const signerId = getSignerAddress(extrinsic);
  const { instructionId: rawInstructionId, mediators: rawIdentityIds } = decodeEvent(event);

  const instructionId = processInstructionId(rawInstructionId);
  const identityIds = getStringArrayValue(rawIdentityIds);

  const instruction = await getInstruction(instructionId);

  instruction.mediators = identityIds;
  instruction.updatedEventId = blockEventId;

  const mediatorEventPromises = identityIds.map((identity, index) => {
    return InstructionEvent.create({
      id: `${blockEventId}/${index}`,
      instructionId,
      event: InstructionEventEnum.InstructionMediators,
      identityId: identity,
      signerId,
      createdEventId: blockEventId,
    }).save();
  });

  // a mediator that has already affirmed keeps its row
  const existing = await Promise.all(
    identityIds.map(did => InstructionAffirmation.get(mediatorAffirmationId(instructionId, did)))
  );
  const pending = identityIds
    .filter((_, index) => !existing[index])
    .map(did => pendingMediatorAffirmation(instructionId, did, blockEventId));

  const parties = new Map<string, PartyDetails>(identityIds.map(did => [did, { identityId: did }]));

  await Promise.all([
    instruction.save(),
    createInstructionParty(instructionId, blockEventId, parties, true),
    ...pending.map(row => row.save()),
    ...mediatorEventPromises,
  ]);
};

/**
 * Maps the event - `settlement.ReceiptClaimed`
 */
export const handleReceiptClaimed = async (event: SubstrateEvent): Promise<void> => {
  const { extrinsic, blockEventId } = extractArgs(event);
  const {
    callerDid: rawIdentityId,
    instructionId: rawInstructionId,
    legId: rawLegId,
    receiptUid: rawReceiptUid,
    signer: rawSigner,
    metadata: rawMetadata,
  } = decodeEvent(event);
  const identityId = getTextValue(rawIdentityId);
  const instructionId = processInstructionId(rawInstructionId);
  const legId = getNumberValue(rawLegId);
  const signer = getTextValue(rawSigner);
  const uid = getNumberValue(rawReceiptUid);

  const receipt = OffChainReceipt.create({
    id: `${signer}/${uid}`,
    uid,
    signerId: signer,
    legId: `${instructionId}/${legId}`,
    metadata: getTextValue(rawMetadata),
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  });

  const partyId = getPartyId(instructionId, identityId, false);

  const affirmation = InstructionAffirmation.create({
    id: `${partyId}/${signer}/${uid}`,
    isMediator: false,
    isAutomaticallyAffirmed: false,
    instructionId,
    identityId: identityId,
    partyId,
    status: AffirmStatusEnum.Affirmed,
    offChainReceiptId: `${signer}/${uid}`,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  });

  const receiptEvent = InstructionEvent.create({
    id: `${blockEventId}/receipt/${legId}`,
    instructionId: processInstructionId(rawInstructionId),
    event: InstructionEventEnum.ReceiptClaimed,
    identityId: identityId,
    signerId: getSignerAddress(extrinsic),
    offChainReceiptId: `${signer}/${uid}`,
    createdEventId: blockEventId,
  });

  const promises = [receipt.save(), affirmation.save(), receiptEvent.save()];

  const party = await InstructionParty.get(partyId);

  if (party) {
    await Promise.all(promises);
  } else {
    await Promise.all([
      InstructionParty.create({
        id: partyId,
        instructionId,
        isMediator: false,
        identityId: identityId,
        createdEventId: blockEventId,
        updatedEventId: blockEventId,
      }).save(),
      ...promises,
    ]);
  }
};

export const handleFundsTransferred = async (event: SubstrateEvent): Promise<void> => {
  const { extrinsic, blockId, eventIdx, block, blockEventId } = extractArgs(event);
  const { from: rawFromHolder, to: rawToHolder, fund: rawFund } = decodeEvent(event);

  const [fromHolder, toHolder] = await Promise.all([
    rawAssetHolderToAssetHolder(rawFromHolder, block, blockId, blockEventId),
    rawAssetHolderToAssetHolder(rawToHolder, block, blockId, blockEventId),
  ]);

  const { description, memo } = JSON.parse(rawFund.toString());
  const assetType = Object.keys(description)[0];
  const fundDescription = description[assetType];

  const moved = await mapAssetMovement({
    blockEventId,
    blockId,
    eventIdx,
    eventId: EventIdEnum.FundsTransferred,
    address: getSignerAddress(extrinsic),
    fromHolder,
    toHolder,
    assetType,
    fundDescription,
    memo: memoText(memo),
    block,
    extrinsic,
  });

  // only a transfer within one identity emits `FundsTransferred`, with no balance event of its own
  await applyMoveWithinIdentity(moved, fromHolder, toHolder, blockEventId, block.specVersion);
};
