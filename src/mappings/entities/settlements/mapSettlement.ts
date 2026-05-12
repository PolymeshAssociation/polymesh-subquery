import { AnyTuple, Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { Instruction, InstructionEvent, Leg, PortfolioMovement } from '../../../types';
import {
  addIfNotIncludes,
  bytesToString,
  coerceHexToString,
  extractAccountOrPortfolio,
  getAssetId,
  getDateValue,
  getErrorDetails,
  getLegsValue,
  getNumberValue,
  getPaginatedData,
  getSettlementLeg,
  getSettlementTypeDetails,
  getSignerAddress,
  getStringArrayValue,
  getTextValue,
  is7xChain,
  padId,
  removeIfIncludes,
} from '../../../utils';
import { extractArgs, HandlerArgs } from '../common';
import { createPortfolioIfNotExists } from '../identities/mapPortfolio';
import {
  AffirmStatusEnum,
  EventIdEnum,
  InstructionEventEnum,
  InstructionStatusEnum,
  PortfolioMovementTypeEnum,
} from './../../../types/enums';
import { InstructionAffirmation } from './../../../types/models/InstructionAffirmation';
import { InstructionParty } from './../../../types/models/InstructionParty';
import { OffChainReceipt } from './../../../types/models/OffChainReceipt';
import { getPortfolioOrAccount, LegDetails } from './../../../utils/settlements';

const instructionStatusMap = {
  [EventIdEnum.InstructionExecuted]: InstructionStatusEnum.Executed,
  [EventIdEnum.InstructionRejected]: InstructionStatusEnum.Rejected,
  [EventIdEnum.InstructionFailed]: InstructionStatusEnum.Failed,
  [EventIdEnum.InstructionCreated]: InstructionStatusEnum.Created,
  [EventIdEnum.FailedToExecuteInstruction]: InstructionStatusEnum.Failed,
  [EventIdEnum.InstructionLocked]: InstructionStatusEnum.Locked,
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
  const legs = await getPaginatedData<Leg, 'instructionId'>('Leg', 'instructionId', instructionId);

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

const getPartyId = (instructionId: string, did: string, account: string, isMediator: boolean) =>
  `${instructionId}/${account ?? did}/${isMediator}`;

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

const mapAutomaticAffirmation = async (
  params: Codec[],
  block: SubstrateBlock,
  blockId: string,
  eventIndex: number,
  blockEventId: string
): Promise<[InstructionEvent, InstructionAffirmation]> => {
  const [, rawHolder, rawInstructionId] = params;
  const instructionId = processInstructionId(rawInstructionId);
  const { identity, account, portfolio } = await getPortfolioOrAccount(rawHolder, block);

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
  const { blockId, params, block, extrinsic, eventIdx, blockEventId } = args;
  const address = getSignerAddress(extrinsic);

  const [
    rawCreator,
    rawVenueId,
    rawInstructionId,
    rawSettlementType,
    rawTradeDate,
    rawValueDate,
    rawLegs,
    rawOptMemo,
  ] = params;

  const creator = getTextValue(rawCreator);

  let legs: LegDetails[];

  const typeDetails = getSettlementTypeDetails(rawSettlementType);

  /**
   * Events from 6.0.0 chain were updated to support NFT and OffChain instructions
   *
   * NOTE - For Polymesh private, the spec version starts from 1.0.0
   */
  const specName = api.runtimeVersion.specName.toString();
  if (block.specVersion >= 6000000 || specName === 'polymesh_private_dev') {
    legs = await getSettlementLeg(rawLegs, block);
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

  /**
   * Till spec version 6.3.1, InstructionAutomaticallyAffirmed was emitted before InstructionCreated event
   * The below logic handles the case for this starting from spec version 6.1.0 from where it was introduced.
   */
  if (
    (block.specVersion >= 6001000 && block.specVersion <= 6003001) ||
    specName !== 'polymesh_private_dev'
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

  await Promise.all([promises]);
};

/**
 * Maps the events -
 *   - InstructionAffirmed
 */
export const handleInstructionUpdate = async (event: SubstrateEvent): Promise<void> => {
  const { params, extrinsic, eventIdx, blockId, block, blockEventId } = extractArgs(event);
  const address = getSignerAddress(extrinsic);

  const [, rawPortfolio, rawInstructionId] = params;

  const instructionId = processInstructionId(rawInstructionId);
  const { identity, account, portfolio } = await getPortfolioOrAccount(rawPortfolio, block);

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
  const { params, eventIdx, blockId, block, blockEventId } = extractArgs(event);

  const [, rawPortfolio, rawInstructionId] = params;

  const instructionId = processInstructionId(rawInstructionId);
  const { identity, account, portfolio } = await getPortfolioOrAccount(rawPortfolio, block);

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
  const {
    params,
    block,
    blockId,
    block: { specVersion },
    eventIdx,
    blockEventId,
  } = extractArgs(event);

  const specName = api.runtimeVersion.specName.toString();

  /**
   * Till spec version 6.3.1, InstructionAutomaticallyAffirmed was emitted before InstructionCreated event
   * The below logic handles the case after 6.3.1 when ordering was correct and we can safely assume instruction exists here
   */
  if (specVersion >= 6003001 || specName === 'polymesh_private_dev') {
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
  const { params, eventId, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [rawIdentityId, rawInstructionId] = params;

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
 */
export const handleInstructionFinalizedEvent = async (event: SubstrateEvent): Promise<void> => {
  const { params, extrinsic, eventId, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [, rawInstructionId] = params;

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
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [rawIdentityId, rawInstructionId] = params;

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
  const { params, eventId, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [rawInstructionId, rawDispatchError] = params;

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
  const { params, blockId, eventIdx, blockEventId } = extractArgs(event);
  const [rawIdentityId, rawInstructionId, expiryOpt] = params;

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
  const { params, blockId, eventIdx, blockEventId } = extractArgs(event);
  const [rawIdentityId, rawInstructionId] = params;
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
  const { params, blockId, eventIdx, blockEventId } = extractArgs(event);
  const [rawInstructionId, rawIdentityIds] = params;
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
  const { params, blockId, eventIdx, blockEventId } = extractArgs(event);
  const [rawIdentityId, rawInstructionId, rawLegId, rawReceiptUid, rawSigner, rawMetadata] = params;
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

  if (!party) {
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
  } else {
    await Promise.all(promises);
  }
};

export const handleFundsTransferred = async (event: SubstrateEvent): Promise<void> => {
  const { params, extrinsic, blockId, block, blockEventId } = extractArgs(event);
  const [, rawFromPortfolio, rawToPortfolio, rawFund] = params;

  const address = getSignerAddress(extrinsic);

  const fromData = await extractAccountOrPortfolio(JSON.parse(rawFromPortfolio.toString()), block);
  const toData = await extractAccountOrPortfolio(JSON.parse(rawToPortfolio.toString()), block);

  let fromPortfolioId: string, toPortfolioId: string, fromAccount: string, toAccount: string;

  if ('account' in fromData) {
    ({ account: fromAccount } = fromData);
  } else {
    fromPortfolioId = `${fromData.identityId}/${fromData.number}`;
  }

  if ('account' in toData) {
    ({ account: toAccount } = toData);
  } else {
    toPortfolioId = `${toData.identityId}/${toData.number}`;
  }

  let assetId: string, amount: bigint, nftIds: bigint[];
  let type: PortfolioMovementTypeEnum;

  const { description, memo } = JSON.parse(rawFund.toString());
  const assetType = Object.keys(description)[0];
  const fundDescription = description[assetType];
  if (assetType === 'fungible') {
    const description = fundDescription as unknown as {
      ticker?: string;
      assetId?: string;
      amount: number;
    };
    assetId = await getAssetId(description.ticker ?? description.assetId, block);
    amount = BigInt(description.amount);
    type = PortfolioMovementTypeEnum.Fungible;
  } else if (assetType === 'nonFungible') {
    const description = fundDescription as unknown as {
      ticker?: string;
      assetId?: string;
      ids: number[];
    };
    nftIds = description.ids.map(id => BigInt(id));
    assetId = await getAssetId(description.ticker ?? description.assetId, block);
    type = PortfolioMovementTypeEnum.NonFungible;
  }

  await PortfolioMovement.create({
    id: blockEventId,
    fromId: fromPortfolioId,
    fromAccount,
    toId: toPortfolioId,
    toAccount,
    type,
    assetId,
    amount,
    nftIds,
    address,
    memo: memo ? coerceHexToString(memo) : undefined,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};
