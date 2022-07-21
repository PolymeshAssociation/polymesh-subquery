import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import {
  EventIdEnum,
  Instruction,
  Leg,
  ModuleIdEnum,
  Settlement,
  Venue,
  SettlementResultEnum,
  InstructionStatusEnum,
} from '../../types';
import {
  getDateValue,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  getLegsValue,
  getSignerAddress,
  getTextValue,
  LegDetails,
} from '../util';
import { HandlerArgs } from './common';

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
  default: SettlementResultEnum.None,
};

const instructionStatusMap = {
  [EventIdEnum.InstructionExecuted]: InstructionStatusEnum.Executed,
  [EventIdEnum.InstructionRejected]: InstructionStatusEnum.Rejected,
  [EventIdEnum.InstructionFailed]: InstructionStatusEnum.Failed,
  [EventIdEnum.InstructionCreated]: InstructionStatusEnum.Created,
};

export const createLeg = async (
  blockId: string,
  instructionId: string,
  address: string,
  legIndex: number,
  { ticker, amount, from, to }: LegDetails
): Promise<void> =>
  Leg.create({
    id: `${instructionId}/${legIndex}`,
    assetId: ticker,
    amount,
    fromId: `${from.identityId}/${from.number}`,
    toId: `${to.identityId}/${to.number}`,
    instructionId,
    addresses: [address],
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();

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
    details: getTextValue(rawDetails),
    type: getTextValue(rawType),
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

const handleVenueDetailsUpdated = async (blockId: string, params: Codec[]): Promise<void> => {
  const [, rawVenueId, rawDetails] = params;

  const venue = await getVenue(getTextValue(rawVenueId));
  venue.details = getTextValue(rawDetails);
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

  const [, rawVenueId, rawInstructionId, rawSettlementType, rawTradeDate, rawValueDate, rawLegs] =
    params;

  const legs = getLegsValue(rawLegs);
  const instructionId = getTextValue(rawInstructionId);

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
    createdBlockId: blockId,
    updatedBlockId: blockId,
  });
  await instruction.save();

  await Promise.all(
    legs.map((legDetails, index) => createLeg(blockId, instructionId, address, index, legDetails))
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
  }
}
