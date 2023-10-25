import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import {
  EventIdEnum,
  Instruction,
  InstructionStatusEnum,
  Leg,
  ModuleIdEnum,
  Settlement,
  SettlementResultEnum,
  Venue,
} from '../../types';
import {
  LegDetails,
  bytesToString,
  getDateValue,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  getLegsValue,
  getSettlementLeg,
  getSignerAddress,
  getTextValue,
} from '../util';
import { HandlerArgs } from './common';
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
  event: SubstrateEvent
): Promise<void> => {
  // since an instruction leg can be created without a valid DID/Portfolio, we make sure DB has an entry for Portfolio/Identity to avoid foreign key constraint
  await Promise.all([
    createPortfolioIfNotExists(from, blockId, event),
    createPortfolioIfNotExists(to, blockId, event),
  ]);

  return Leg.create({
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

const handleInstructionCreated = async (
  blockId: string,
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> => {
  const address = getSignerAddress(event);

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
   */
  if (event.block.specVersion >= 6000000) {
    legs = getSettlementLeg(rawLegs);
  } else {
    legs = getLegsValue(rawLegs);
  }

  const instructionId = getTextValue(rawInstructionId);
  const memo = bytesToString(rawOptMemo);

  const instruction = Instruction.create({
    id: instructionId,
    eventId,
    eventIdx: event.idx,
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

  await Promise.all(
    legs.map((legDetails, index) =>
      createLeg(blockId, instructionId, address, index, legDetails, event)
    )
  );
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
  event: SubstrateEvent
): Promise<void> => {
  const address = getSignerAddress(event);

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
  event: SubstrateEvent
): Promise<void> => {
  const [, rawInstructionId] = params;

  const address = getSignerAddress(event);
  const instructionId = getTextValue(rawInstructionId);
  const instruction = await getInstruction(instructionId);

  instruction.status = instructionStatusMap[eventId];
  instruction.eventId = eventId;
  instruction.updatedBlockId = blockId;

  const settlementId = `${blockId}/${event.idx}`;

  const settlement = Settlement.create({
    id: settlementId,
    result: settlementResultMap[eventId] || settlementResultMap['default'],
    createdBlockId: blockId,
    updatedBlockId: blockId,
  });

  await Promise.all([
    settlement.save(),
    instruction.save(),
    ...(await updateLegs(blockId, address, instructionId, settlementId)),
  ]);
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

export async function mapSettlement({
  blockId,
  eventId,
  moduleId,
  params,
  event,
}: HandlerArgs): Promise<void> {
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
      await handleInstructionCreated(blockId, eventId, params, event);
    }

    if (updateEvents.includes(eventId)) {
      await handleInstructionUpdate(blockId, eventId, params, event);
    }

    if (finalizedEvents.includes(eventId)) {
      await handleInstructionFinalizedEvent(blockId, eventId, params, event);
    }

    if (eventId === EventIdEnum.FailedToExecuteInstruction) {
      await handleFailedToExecuteInstruction(blockId, params);
    }
  }
}
