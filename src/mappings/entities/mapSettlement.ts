import { Codec } from '@polkadot/types/types';
import { SubstrateExtrinsic } from '@subql/types';
import {
  EventIdEnum,
  IdentityInstructions,
  Instruction,
  InstructionStatusEnum,
  Leg,
  MediatorAffirmationStatus,
  MeditatorAffirmation,
  ModuleIdEnum,
  Settlement,
  SettlementResultEnum,
  Venue,
} from '../../types';
import { HandlerArgs } from '../entities/common';
import {
  LegDetails,
  bytesToString,
  getDateValue,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  getLegsValue,
  getSettlementLeg,
  getSignerAddress,
  getStringArrayValue,
  getTextValue,
} from '../util';
import { createPortfolioIfNotExists } from './mapPortfolio';

const updateEvents: EventIdEnum[] = [
  EventIdEnum.InstructionAuthorized,
  EventIdEnum.InstructionUnauthorized,
  EventIdEnum.InstructionAffirmed,
];

const finalizedEvents: EventIdEnum[] = [
  EventIdEnum.InstructionExecuted,
  EventIdEnum.InstructionRejected,
  EventIdEnum.InstructionFailed,
];

const settlementResultMap = {
  [EventIdEnum.InstructionExecuted]: SettlementResultEnum.Executed,
  [EventIdEnum.InstructionRejected]: SettlementResultEnum.Rejected,
  [EventIdEnum.InstructionFailed]: SettlementResultEnum.Failed,
  [EventIdEnum.FailedToExecuteInstruction]: SettlementResultEnum.Failed,
  default: SettlementResultEnum.None,
};

const instructionStatusMap = {
  [EventIdEnum.InstructionExecuted]: InstructionStatusEnum.Executed,
  [EventIdEnum.InstructionRejected]: InstructionStatusEnum.Rejected,
  [EventIdEnum.InstructionFailed]: InstructionStatusEnum.Failed,
  [EventIdEnum.InstructionCreated]: InstructionStatusEnum.Created,
  [EventIdEnum.FailedToExecuteInstruction]: InstructionStatusEnum.Failed,
};

export const createLeg = async (
  blockId: string,
  instructionId: string,
  address: string,
  legIndex: number,
  { ticker, amount, nftIds, from, to, legType }: LegDetails,
  { eventIdx, eventId, block }: HandlerArgs
): Promise<string[]> => {
  // since an instruction leg can be created without a valid DID/Portfolio, we make sure DB has an entry for Portfolio/Identity to avoid foreign key constraint
  await Promise.all([
    createPortfolioIfNotExists(from, blockId, eventId, eventIdx, block),
    createPortfolioIfNotExists(to, blockId, eventId, eventIdx, block),
  ]);

  await Leg.create({
    id: `${instructionId}/${legIndex}`,
    assetId: ticker,
    amount,
    nftIds,
    fromId: `${from.identityId}/${from.number}`,
    toId: `${to.identityId}/${to.number}`,
    legType,
    instructionId,
    addresses: [address],
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();

  return [from.identityId, to.identityId];
};

const updateLegs = async (
  blockId: string,
  address: string,
  instructionId: string,
  settlementId?: string
): Promise<Promise<void>[]> => {
  const legs = await Leg.getByInstructionId(instructionId);

  return legs.map(leg => {
    if (address) {
      leg.addresses = [...new Set([...leg.addresses, address])];
    }
    if (settlementId) {
      leg.settlementId = settlementId;
    }
    leg.updatedBlockId = blockId;
    return leg.save();
  });
};

const getVenue = async (venueId: string): Promise<Venue> => {
  const venue = await Venue.get(venueId);

  if (!venue) {
    throw new Error(`Venue with id ${venueId} was not found`);
  }

  return venue;
};

const createIdentityInstructionRelation = async (
  instructionId: string,
  blockId: string,
  identityList: string[]
): Promise<void> => {
  const uniqueDids = [...new Set(identityList)];

  const promises = uniqueDids.map(did =>
    IdentityInstructions.create({
      id: `${did}/${instructionId}/${blockId}`,
      identityId: did,
      instructionId,
    }).save()
  );

  await Promise.all(promises);
};

const handleVenueCreated = async (blockId: string, params: Codec[]): Promise<void> => {
  const [rawIdentity, rawVenueId, rawDetails, rawType] = params;

  await Venue.create({
    id: getTextValue(rawVenueId),
    ownerId: getTextValue(rawIdentity),
    details: bytesToString(rawDetails),
    type: getTextValue(rawType),
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

const handleVenueDetailsUpdated = async (blockId: string, params: Codec[]): Promise<void> => {
  const [, rawVenueId, rawDetails] = params;

  const venue = await getVenue(getTextValue(rawVenueId));
  venue.details = bytesToString(rawDetails);
  venue.updatedBlockId = blockId;

  await venue.save();
};

const handleVenueTypeUpdated = async (blockId: string, params: Codec[]): Promise<void> => {
  const [, rawVenueId, rawType] = params;

  const venue = await getVenue(getTextValue(rawVenueId));
  venue.type = getTextValue(rawType);
  venue.updatedBlockId = blockId;

  await venue.save();
};

const handleInstructionCreated = async (args: HandlerArgs): Promise<void> => {
  const { blockId, eventId, eventIdx, params, block, extrinsic } = args;
  const address = getSignerAddress(extrinsic);

  const [
    ,
    rawVenueId,
    rawInstructionId,
    rawSettlementType,
    rawTradeDate,
    rawValueDate,
    rawLegs,
    rawOptMemo,
  ] = params;

  let legs: LegDetails[];

  /**
   * Events from 6.0.0 chain were updated to support NFT and OffChain instructions
   *
   * NOTE - For Polymesh private, the spec version starts from 1.0.0
   */
  const specName = api.runtimeVersion.specName.toString();
  if (block.specVersion >= 6000000 || specName === 'polymesh_private_dev') {
    legs = getSettlementLeg(rawLegs);
  } else {
    legs = getLegsValue(rawLegs);
  }

  const instructionId = getTextValue(rawInstructionId);
  const memo = bytesToString(rawOptMemo);

  const instruction = Instruction.create({
    id: instructionId,
    eventId,
    eventIdx,
    status: InstructionStatusEnum.Created,
    venueId: getTextValue(rawVenueId),
    settlementType: getFirstKeyFromJson(rawSettlementType),
    endBlock: Number(getFirstValueFromJson(rawSettlementType)),
    tradeDate: getDateValue(rawTradeDate),
    valueDate: getDateValue(rawValueDate),
    memo,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  });
  await instruction.save();

  const dids = await Promise.all(
    legs.map((legDetails, index) =>
      createLeg(blockId, instructionId, address, index, legDetails, args)
    )
  );

  await createIdentityInstructionRelation(instructionId, blockId, dids.flat());
};

const getInstruction = async (instructionId: string): Promise<Instruction> => {
  const instruction = await Instruction.get(instructionId);

  if (!instruction) {
    throw new Error(`could not find instruction by id: ${instructionId}`);
  }

  return instruction;
};

const handleInstructionUpdate = async (
  blockId: string,
  eventId: EventIdEnum,
  params: Codec[],
  extrinsic?: SubstrateExtrinsic
): Promise<void> => {
  const address = getSignerAddress(extrinsic);

  const [, , rawInstructionId] = params;

  const instructionId = getTextValue(rawInstructionId);
  const instruction = await getInstruction(instructionId);
  instruction.eventId = eventId;
  instruction.updatedBlockId = blockId;

  await Promise.all([instruction.save(), ...(await updateLegs(blockId, address, instructionId))]);
};

const handleInstructionFinalizedEvent = async (
  blockId: string,
  eventId: EventIdEnum,
  params: Codec[],
  eventIdx: number,
  extrinsic?: SubstrateExtrinsic
): Promise<void> => {
  const [rawIdentityId, rawInstructionId] = params;

  const address = getSignerAddress(extrinsic);
  const instructionId = getTextValue(rawInstructionId);
  const instruction = await getInstruction(instructionId);

  instruction.status = instructionStatusMap[eventId];
  instruction.eventId = eventId;
  instruction.updatedBlockId = blockId;

  const settlementId = `${blockId}/${eventIdx}`;

  const settlement = Settlement.create({
    id: settlementId,
    result: settlementResultMap[eventId] || settlementResultMap['default'],
    createdBlockId: blockId,
    updatedBlockId: blockId,
  });

  const promises = [
    settlement.save(),
    instruction.save(),
    ...(await updateLegs(blockId, address, instructionId, settlementId)),
  ];

  // incase the rejector was a mediator who previously affirmed their affirmation should be removed
  if (eventId === EventIdEnum.InstructionRejected) {
    const clearMediatorAffirmation = async () => {
      const identityId = getTextValue(rawIdentityId);
      const id = `${identityId}/${instructionId}`;
      const mediatorAffirmation = await MeditatorAffirmation.get(id);
      if (mediatorAffirmation) {
        mediatorAffirmation.status = MediatorAffirmationStatus.Rejected;
        mediatorAffirmation.updatedBlockId = blockId;
        await mediatorAffirmation.save();
      }
    };

    promises.push(clearMediatorAffirmation());
  }

  await Promise.all(promises);
};

const handleFailedToExecuteInstruction = async (
  blockId: string,
  params: Codec[]
): Promise<void> => {
  const [rawInstructionId] = params;
  const instructionId = getTextValue(rawInstructionId);

  const instruction = await getInstruction(instructionId);

  instruction.eventId = EventIdEnum.FailedToExecuteInstruction;
  instruction.status = instructionStatusMap[EventIdEnum.FailedToExecuteInstruction];
  instruction.updatedBlockId = blockId;

  await instruction.save();
};

const handleMediatorAffirmation = async (blockId: string, params: Codec[]): Promise<void> => {
  const [rawIdentityId, rawInstructionId, expiryOpt] = params;

  const identityId = getTextValue(rawIdentityId);
  const instructionId = getTextValue(rawInstructionId);
  const expiry = getDateValue(expiryOpt);

  const affirmation = await MeditatorAffirmation.get(`${identityId}/${instructionId}`);

  affirmation.status = MediatorAffirmationStatus.Affirmed;
  affirmation.expiry = expiry;
  affirmation.updatedBlockId = blockId;

  await affirmation.save();
};

const handleMediatorWithdrawn = async (blockId: string, params: Codec[]): Promise<void> => {
  const [rawIdentityId, rawInstructionId] = params;
  const identityId = getTextValue(rawIdentityId);
  const instructionId = getTextValue(rawInstructionId);

  const affirmation = await MeditatorAffirmation.get(`${identityId}/${instructionId}`);

  affirmation.status = MediatorAffirmationStatus.Pending;
  affirmation.expiry = undefined;
  affirmation.updatedBlockId = blockId;

  await affirmation.save();
};

const handleInstructionMediators = async (blockId: string, params: Codec[]): Promise<void> => {
  const [rawInstructionId, rawIdentityIds] = params;
  const instructionId = getTextValue(rawInstructionId);
  const identityIds = getStringArrayValue(rawIdentityIds);

  const promises = identityIds.map(identityId => {
    return MeditatorAffirmation.create({
      id: `${identityId}/${instructionId}`,
      identityId,
      instructionId,
      status: MediatorAffirmationStatus.Pending,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  });

  await Promise.all(promises);
};

export async function mapSettlement(args: HandlerArgs): Promise<void> {
  const { blockId, eventId, moduleId, params, eventIdx, extrinsic } = args;
  if (moduleId === ModuleIdEnum.settlement) {
    if (eventId === EventIdEnum.VenueCreated) {
      await handleVenueCreated(blockId, params);
    }

    if (eventId === EventIdEnum.VenueDetailsUpdated) {
      await handleVenueDetailsUpdated(blockId, params);
    }

    if (eventId === EventIdEnum.VenueTypeUpdated) {
      await handleVenueTypeUpdated(blockId, params);
    }

    if (eventId === EventIdEnum.InstructionCreated) {
      await handleInstructionCreated(args);
    }

    if (eventId === EventIdEnum.MediatorAffirmationReceived) {
      await handleMediatorAffirmation(blockId, params);
    }

    if (eventId === EventIdEnum.MediatorAffirmationWithdrawn) {
      await handleMediatorWithdrawn(blockId, params);
    }

    if (eventId === EventIdEnum.InstructionMediators) {
      await handleInstructionMediators(blockId, params);
    }

    if (updateEvents.includes(eventId)) {
      await handleInstructionUpdate(blockId, eventId, params, extrinsic);
    }

    if (finalizedEvents.includes(eventId)) {
      await handleInstructionFinalizedEvent(blockId, eventId, params, eventIdx, extrinsic);
    }

    if (eventId === EventIdEnum.FailedToExecuteInstruction) {
      await handleFailedToExecuteInstruction(blockId, params);
    }
  }
}
