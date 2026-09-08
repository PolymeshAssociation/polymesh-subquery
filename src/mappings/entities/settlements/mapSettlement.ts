import { AnyTuple, Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { Instruction, InstructionEvent, Leg } from '../../../types';
import {
  addIfNotIncludes,
  bytesToString,
  coerceHexToString,
  getDateValue,
  getErrorDetails,
  getLegsValue,
  getNumberValue,
  getAllByFields,
  getSettlementLeg,
  getSettlementTypeDetails,
  getSignerAddress,
  getStringArrayValue,
  getTextValue,
  is7xChain,
  padId,
  rawAssetHolderToAssetHolder,
  removeIfIncludes,
  specVersionOf,
} from '../../../utils';
import { extractArgs, HandlerArgs } from '../common';
import { createPortfolioIfNotExists, mapAssetMovement } from '../identities/mapPortfolio';
import {
  AffirmStatusEnum,
  EventIdEnum,
  InstructionEventEnum,
  InstructionStatusEnum,
} from './../../../types/enums';
import { InstructionAffirmation } from './../../../types/models/InstructionAffirmation';
import { InstructionParty } from './../../../types/models/InstructionParty';
import { OffChainReceipt } from './../../../types/models/OffChainReceipt';
import { getPortfolioOrAccount, LegDetails } from './../../../utils/settlements';

/**
 * Until spec 6.3.1, `InstructionAutomaticallyAffirmed` was emitted *before* `InstructionCreated`,
 * so `handleInstructionCreated` re-scans the block for it. That workaround must be scoped to the
 * 6.1.0–6.3.1 window on public chains; a folded `||` previously made it run on every non-private
 * block at any spec version (defect A4). The private-chain equivalent range is unknown — if one is
 * ever needed, add it as an explicit second clause rather than widening this one.
 */
export const shouldRescanAutomaticAffirmations = (specName: string, specVersion: number): boolean =>
  specName !== 'polymesh_private_dev' && specVersion >= 6001000 && specVersion <= 6003001;

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
  address: string,
  legDetails: LegDetails,
  { eventIdx, eventId, block, blockEventId }: HandlerArgs
): Promise<Parameters<typeof Leg.create>[0]> => {
  const { from, fromPortfolio, to, toPortfolio, legIndex } = legDetails;
  const promises = [];

  /**
   * older versions did not ensure the existence of sender and receivers, so entries may need to be added
   */
  if (is7xChain(block)) {
    if (fromPortfolio) {
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
    if (toPortfolio) {
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
    addresses: [address],
    createdBlockId: blockId,
    updatedBlockId: blockId,
  };
};

const updateLegs = async (
  blockId: string,
  address: string,
  instructionId: string
): Promise<void> => {
  const legs = await getAllByFields<Leg>('Leg', [['instructionId', '=', instructionId]]);

  const updatedLegs = legs.map(leg => {
    if (address) {
      addIfNotIncludes(leg.addresses, address);
    }
    leg.updatedBlockId = blockId;

    return leg;
  });

  return store.bulkUpdate('Leg', updatedLegs);
};

export const processInstructionId = (id: Codec): string => {
  return getTextValue(id);
};

const getInstruction = async (instructionId: string): Promise<Instruction> => {
  const instruction = await Instruction.get(instructionId);

  if (!instruction) {
    throw new Error(`could not find instruction by id: ${instructionId}`);
  }

  return instruction;
};

const getPartyId = (
  instructionId: string,
  did: string,
  account: string | undefined,
  isMediator: boolean
) => `${instructionId}/${account ?? did}/${isMediator}`;

const createInstructionParty = async (
  instructionId: string,
  blockId: string,
  parties: Record<string, number[] | undefined>,
  isMediator: boolean
): Promise<void> => {
  const promises = Object.keys(parties).map(did =>
    InstructionParty.create({
      id: getPartyId(instructionId, did, undefined, isMediator),
      instructionId,
      isMediator,
      identity: did,
      portfolios: parties[did],
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save()
  );

  await Promise.all(promises);
};

/**
 * Reads a `settlement.InstructionAutomaticallyAffirmed` from its raw parameters.
 *
 * Takes parameters rather than the event because the 6.1.0 to 6.3.1 re-scan feeds it sibling
 * `EventRecord`s from the same block, for which there is no `SubstrateEvent` to decode. Its
 * shape is registered as `settlement.InstructionAutomaticallyAffirmed` and is covered by the
 * metadata contract test like any other.
 */
const mapAutomaticAffirmation = async (
  params: Codec[],
  block: SubstrateBlock,
  blockId: string,
  eventIndex: number,
  blockEventId: string
): Promise<[InstructionEvent, InstructionAffirmation]> => {
  const [, rawHolder, rawInstructionId] = params;
  const instructionId = processInstructionId(rawInstructionId);
  const { identity, account, portfolio } = await getPortfolioOrAccount(rawHolder, block, blockId);

  const automaticAffirmationEvent = InstructionEvent.create({
    id: blockEventId,
    instructionId,
    event: InstructionEventEnum.InstructionAutomaticallyAffirmed,
    eventIdx: eventIndex,
    identity,
    account,
    portfolio,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  });

  const partyId = getPartyId(instructionId, identity, account, false);

  const affirmation = await InstructionAffirmation.get(partyId);

  if (affirmation) {
    addIfNotIncludes(affirmation.portfolios, portfolio);
    affirmation.updatedBlockId = blockId;

    return [automaticAffirmationEvent, affirmation];
  }

  const automaticAffirmation = InstructionAffirmation.create({
    id: partyId,
    instructionId,
    partyId,
    identity,
    account,
    portfolios: [portfolio],
    isMediator: false,
    isAutomaticallyAffirmed: true,
    status: AffirmStatusEnum.Affirmed,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  });

  return [automaticAffirmationEvent, automaticAffirmation];
};

/**
 * Maps the event 'settlement.InstructionCreated'
 */
export const handleInstructionCreated = async (event: SubstrateEvent): Promise<void> => {
  const args = extractArgs(event);
  const { blockId, block, extrinsic, eventIdx, blockEventId } = args;
  const address = getSignerAddress(extrinsic);

  const {
    did: rawCreator,
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
    legs = await getSettlementLeg(rawLegs, block, blockId);
  } else {
    legs = await getLegsValue(rawLegs, block);
  }

  const instructionId = processInstructionId(rawInstructionId);
  const memo = bytesToString(rawOptMemo);

  const instruction = Instruction.create({
    id: instructionId,
    status: InstructionStatusEnum.Created,
    venueId: getTextValue(rawVenueId),
    ...typeDetails,
    tradeDate: getDateValue(rawTradeDate),
    valueDate: getDateValue(rawValueDate),
    memo,
    mediators: [],
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  });
  await instruction.save();

  const legParams = await Promise.all(
    legs.map(legDetails =>
      prepareLegCreateParams(blockId, instructionId, address, legDetails, args)
    )
  );

  const parties = {};
  legParams.forEach(leg => {
    const addParty = (did: string, portfolio?: number): void => {
      if (portfolio === undefined) {
        parties[did] = undefined;
      } else {
        parties[did] = [...(parties[did] || []), portfolio];
      }
    };

    if (leg.fromAccount) {
      addParty(leg.fromAccount);
    } else {
      addParty(leg.from, leg.fromPortfolio);
    }
    if (leg.toAccount) {
      addParty(leg.toAccount);
    } else {
      addParty(leg.to, leg.toPortfolio);
    }
  });

  const instructionCreatedEvent = InstructionEvent.create({
    id: blockEventId,
    instructionId,
    event: InstructionEventEnum.InstructionCreated,
    eventIdx,
    identity: creator,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  });

  const promises = [
    store.bulkCreate('Leg', legParams),
    createInstructionParty(instructionId, blockId, parties, false),
    instructionCreatedEvent.save(),
  ];

  if (
    shouldRescanAutomaticAffirmations(api.runtimeVersion.specName.toString(), block.specVersion)
  ) {
    const automaticAffirmationPromises = [];
    block.events.forEach((event, eventIndex) => {
      if (event.event.method === EventIdEnum.InstructionAutomaticallyAffirmed) {
        const automaticAffirmationPromise = async () => {
          const blockEventId = `${blockId}/${padId(eventIndex.toString())}`;
          const [automaticAffirmationEvent, automaticAffirmation] = await mapAutomaticAffirmation(
            event.event.data as unknown as AnyTuple,
            block,
            blockId,
            eventIndex,
            blockEventId
          );
          promises.push(automaticAffirmation.save(), automaticAffirmationEvent.save());
        };
        automaticAffirmationPromises.push(automaticAffirmationPromise());
      }
    });

    await Promise.all(automaticAffirmationPromises);
  }

  await Promise.all(promises);
};

/**
 * Maps the events -
 *   - InstructionAffirmed
 */
export const handleInstructionUpdate = async (event: SubstrateEvent): Promise<void> => {
  const { extrinsic, eventIdx, blockId, block, blockEventId } = extractArgs(event);
  const address = getSignerAddress(extrinsic);

  const { portfolio: rawPortfolio, instructionId: rawInstructionId } = decodeEvent(event);

  const instructionId = processInstructionId(rawInstructionId);
  const { identity, account, portfolio } = await getPortfolioOrAccount(
    rawPortfolio,
    block,
    blockId
  );

  const partyId = getPartyId(instructionId, identity, account, false);

  let affirmation = await InstructionAffirmation.get(partyId);

  if (affirmation) {
    addIfNotIncludes(affirmation.portfolios, portfolio);
    affirmation.updatedBlockId = blockId;
  } else {
    affirmation = InstructionAffirmation.create({
      id: partyId,
      instructionId,
      partyId,
      account,
      identity,
      portfolios: [portfolio],
      isMediator: false,
      isAutomaticallyAffirmed: false,
      status: AffirmStatusEnum.Affirmed,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    });
  }

  const affirmationEvent = InstructionEvent.create({
    id: blockEventId,
    instructionId,
    event: InstructionEventEnum.InstructionAffirmed,
    eventIdx,
    identity,
    portfolio,
    account,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  });

  await Promise.all([
    affirmation.save(),
    affirmationEvent.save(),
    updateLegs(blockId, address, instructionId),
  ]);
};

/**
 * Maps the event - `settlement.AffirmationWithdrawn`
 */
export const handleAffirmationWithdrawn = async (event: SubstrateEvent): Promise<void> => {
  const { eventIdx, blockId, block, blockEventId } = extractArgs(event);

  const { portfolio: rawPortfolio, instructionId: rawInstructionId } = decodeEvent(event);

  const instructionId = processInstructionId(rawInstructionId);
  const { identity, account, portfolio } = await getPortfolioOrAccount(
    rawPortfolio,
    block,
    blockId
  );

  const partyId = getPartyId(instructionId, identity, account, false);
  const affirmation = await InstructionAffirmation.get(partyId);

  const promises = [
    InstructionEvent.create({
      id: blockEventId,
      instructionId,
      event: InstructionEventEnum.AffirmationWithdrawn,
      eventIdx,
      identity,
      account,
      portfolio,
      createdBlockId: blockId,
      updatedBlockId: blockId,
      createdEventId: blockEventId,
    }).save(),
  ];

  if (affirmation) {
    if (affirmation.portfolios.length === 1) {
      // if only single PF is present remove the entire entity value
      promises.push(InstructionAffirmation.remove(partyId));
    } else {
      // else remove the withdrawn portfolio from affirmed portfolio list
      removeIfIncludes(affirmation.portfolios, portfolio);
      affirmation.updatedBlockId = blockId;

      promises.push(affirmation.save());
    }
  }

  await Promise.all(promises);
};

/**
 * Maps the event - `settlement.InstructionAutomaticallyAffirmed
 */
export const handleAutomaticAffirmation = async (event: SubstrateEvent): Promise<void> => {
  const { params, block, blockId, eventIdx, blockEventId } = extractArgs(event);

  /**
   * Till spec version 6.3.1, InstructionAutomaticallyAffirmed was emitted before InstructionCreated event
   * The below logic handles the case after 6.3.1 when ordering was correct and we can safely assume instruction exists here
   */
  if (specVersionOf(block) >= 6_003_001) {
    const [instructionEvent, instructionAffirmation] = await mapAutomaticAffirmation(
      params,
      block,
      blockId,
      eventIdx,
      blockEventId
    );
    await Promise.all([instructionEvent.save(), instructionAffirmation.save()]);
  }
};

/**
 * Maps the event - `settlement.InstructionRejected`
 */
export const handleInstructionRejected = async (event: SubstrateEvent): Promise<void> => {
  const { eventId, eventIdx, blockId, blockEventId } = extractArgs(event);
  const { did: rawIdentityId, instructionId: rawInstructionId } = decodeEvent(event);

  const identityId = getTextValue(rawIdentityId);
  const instructionId = processInstructionId(rawInstructionId);

  const instruction = await getInstruction(instructionId);

  instruction.status = instructionStatusMap[eventId];
  instruction.updatedBlockId = blockId;

  const isMediator = instruction.mediators.includes(identityId);

  const partyId = getPartyId(instructionId, identityId, undefined, isMediator);

  const rejection = InstructionAffirmation.create({
    id: partyId,
    instructionId,
    partyId: partyId,
    identity: identityId,
    isMediator: isMediator,
    isAutomaticallyAffirmed: false,
    status: AffirmStatusEnum.Rejected,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  });

  const rejectionEvent = InstructionEvent.create({
    id: blockEventId,
    instructionId,
    event: InstructionEventEnum.InstructionRejected,
    eventIdx,
    identity: identityId,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  });

  await Promise.all([instruction.save(), rejection.save(), rejectionEvent.save()]);
};

/**
 * Maps events -
 *   - settlement.InstructionExecuted
 *   - settlement.InstructionFailed
 *   - settlement.InstructionLocked
 *   - settlement.InstructionUnlocked
 */
export const handleInstructionFinalizedEvent = async (event: SubstrateEvent): Promise<void> => {
  const { extrinsic, eventId, eventIdx, blockId, blockEventId } = extractArgs(event);
  const { instructionId: rawInstructionId } = decodeEvent(event);

  const address = getSignerAddress(extrinsic);
  const instructionId = processInstructionId(rawInstructionId);
  const instruction = await getInstruction(instructionId);

  instruction.status = instructionStatusMap[eventId];
  instruction.updatedBlockId = blockId;

  const finalizedEvent = InstructionEvent.create({
    id: blockEventId,
    instructionId,
    event: eventId as unknown as InstructionEventEnum,
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  });

  await Promise.all([
    instruction.save(),
    finalizedEvent.save(),
    updateLegs(blockId, address, instructionId),
  ]);
};

/**
 * Maps the event - `settlement.SettlementManuallyExecuted`
 */
export const handleSettlementManuallyExecuted = async (event: SubstrateEvent): Promise<void> => {
  const { eventIdx, blockId, blockEventId } = extractArgs(event);
  const { did: rawIdentityId, instructionId: rawInstructionId } = decodeEvent(event);

  const manuallyExecutedEvent = InstructionEvent.create({
    id: blockEventId,
    instructionId: processInstructionId(rawInstructionId),
    event: InstructionEventEnum.SettlementManuallyExecuted,
    eventIdx,
    identity: getTextValue(rawIdentityId),
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  });

  await manuallyExecutedEvent.save();
};

/**
 * Maps the event `settlement.FailedToExecuteInstruction`
 */
export const handleFailedToExecuteInstruction = async (event: SubstrateEvent): Promise<void> => {
  const { eventId, eventIdx, blockId, blockEventId } = extractArgs(event);
  const { instructionId: rawInstructionId, error: rawDispatchError } = decodeEvent(event);

  const instructionId = processInstructionId(rawInstructionId);
  const instruction = await getInstruction(instructionId);

  const failureReason = getErrorDetails(rawDispatchError);

  instruction.updatedBlockId = blockId;
  instruction.status = InstructionStatusEnum.Failed;
  instruction.failureReason = failureReason;

  const finalizedEvent = InstructionEvent.create({
    id: blockEventId,
    instructionId,
    event: eventId as unknown as InstructionEventEnum,
    eventIdx,
    failureReason,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  });

  await Promise.all([instruction.save(), finalizedEvent.save()]);
};

export const handleMediatorAffirmationReceived = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, eventIdx, blockEventId } = extractArgs(event);
  const {
    did: rawIdentityId,
    instructionId: rawInstructionId,
    expiry: expiryOpt,
  } = decodeEvent(event);

  const identityId = getTextValue(rawIdentityId);
  const instructionId = processInstructionId(rawInstructionId);
  const expiry = getDateValue(expiryOpt);

  const partyId = getPartyId(instructionId, identityId, undefined, true);
  const mediatorAffirmation = InstructionAffirmation.create({
    id: partyId,
    instructionId,
    partyId,
    identity: identityId,
    isMediator: true,
    status: AffirmStatusEnum.Affirmed,
    isAutomaticallyAffirmed: false,
    expiry,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  });

  const mediatorAffirmationEvent = InstructionEvent.create({
    id: blockEventId,
    instructionId,
    event: InstructionEventEnum.MediatorAffirmationReceived,
    eventIdx,
    identity: identityId,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  });

  await Promise.all([mediatorAffirmation.save(), mediatorAffirmationEvent.save()]);
};

export const handleMediatorAffirmationWithdrawn = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, eventIdx, blockEventId } = extractArgs(event);
  const { did: rawIdentityId, instructionId: rawInstructionId } = decodeEvent(event);

  const identityId = getTextValue(rawIdentityId);
  const instructionId = getTextValue(rawInstructionId);

  const affirmationWithdrawnEvent = InstructionEvent.create({
    id: blockEventId,
    instructionId: processInstructionId(rawInstructionId),
    event: InstructionEventEnum.MediatorAffirmationWithdrawn,
    eventIdx,
    identity: identityId,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  });

  await Promise.all([
    InstructionAffirmation.remove(getPartyId(instructionId, identityId, undefined, true)),
    affirmationWithdrawnEvent.save(),
  ]);
};

/**
 * Maps the event - `settlement.InstructionMediators`
 */
export const handleInstructionMediators = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, eventIdx, blockEventId } = extractArgs(event);
  const { instructionId: rawInstructionId, mediators: rawIdentityIds } = decodeEvent(event);

  const instructionId = processInstructionId(rawInstructionId);
  const identityIds = getStringArrayValue(rawIdentityIds);

  const instruction = await getInstruction(instructionId);

  instruction.mediators = identityIds;
  instruction.updatedBlockId = blockId;

  const mediatorEventPromises = identityIds.map((identity, index) => {
    return InstructionEvent.create({
      id: `${blockEventId}/${index}`,
      instructionId,
      event: InstructionEventEnum.InstructionMediators,
      eventIdx,
      identity,
      createdBlockId: blockId,
      updatedBlockId: blockId,
      createdEventId: blockEventId,
    }).save();
  });

  const parties = {};
  identityIds.forEach(did => {
    parties[did] = undefined;
  });

  await Promise.all([
    instruction.save(),
    createInstructionParty(instructionId, blockId, parties, true),
    ...mediatorEventPromises,
  ]);
};

/**
 * Maps the event - `settlement.ReceiptClaimed`
 */
export const handleReceiptClaimed = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, eventIdx, blockEventId } = extractArgs(event);
  const {
    did: rawIdentityId,
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
    signer,
    legId: `${instructionId}/${legId}`,
    metadata: getTextValue(rawMetadata),
    createdBlockId: blockId,
    updatedBlockId: blockId,
  });

  const partyId = getPartyId(instructionId, identityId, undefined, false);

  const affirmation = InstructionAffirmation.create({
    id: `${partyId}/${signer}/${uid}`,
    isMediator: false,
    isAutomaticallyAffirmed: false,
    instructionId,
    identity: identityId,
    partyId,
    status: AffirmStatusEnum.Affirmed,
    offChainReceiptId: `${signer}/${uid}`,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  });

  const receiptEvent = InstructionEvent.create({
    id: `${blockEventId}/receipt/${legId}`,
    instructionId: processInstructionId(rawInstructionId),
    event: InstructionEventEnum.ReceiptClaimed,
    eventIdx,
    identity: identityId,
    offChainReceiptId: `${signer}/${uid}`,
    createdBlockId: blockId,
    updatedBlockId: blockId,
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
        identity: identityId,
        createdBlockId: blockId,
        updatedBlockId: blockId,
      }).save(),
      ...promises,
    ]);
  }
};

export const handleFundsTransferred = async (event: SubstrateEvent): Promise<void> => {
  const { extrinsic, blockId, block, blockEventId } = extractArgs(event);
  const { fromHolder: rawFromHolder, toHolder: rawToHolder, fund: rawFund } = decodeEvent(event);

  const address = getSignerAddress(extrinsic);

  const [fromHolder, toHolder] = await Promise.all([
    rawAssetHolderToAssetHolder(rawFromHolder, block, blockId),
    rawAssetHolderToAssetHolder(rawToHolder, block, blockId),
  ]);

  const { description, memo } = JSON.parse(rawFund.toString());
  const assetType = Object.keys(description)[0];
  const fundDescription = description[assetType];

  await mapAssetMovement({
    blockEventId,
    blockId,
    address,
    fromHolder,
    toHolder,
    assetType,
    fundDescription,
    memo: memo ? coerceHexToString(memo) : undefined,
    block,
  });
};
