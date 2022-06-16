import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { Instruction, Leg, Settlement, Venue } from '../../types';
import {
  getDateValue,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  getLegsValue,
  getSignerAddress,
  getTextValue,
  LegDetails,
} from '../util';
import { EventIdEnum, HandlerArgs, ModuleIdEnum } from './common';

export enum SettlementResultEnum {
  None = 'None',
  Executed = 'Executed',
  Failed = 'Failed',
  Rejected = 'Rejected',
}

enum InstructionStatusEnum {
  Created = 'Created',
  Executed = 'Executed',
  Rejected = 'Rejected',
  Failed = 'Failed',
}

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

const instructionResultMap = {
  [EventIdEnum.InstructionExecuted]: SettlementResultEnum.Executed,
  [EventIdEnum.InstructionRejected]: SettlementResultEnum.Rejected,
  [EventIdEnum.InstructionFailed]: SettlementResultEnum.Failed,
  default: SettlementResultEnum.None,
};

export const createLeg = async (
  blockId: string,
  instructionId: string,
  legIndex: number,
  { ticker, amount, from, to }: LegDetails
): Promise<void> =>
  Leg.create({
    id: `${instructionId}/${legIndex}`,
    ticker,
    amount,
    fromId: `${from.identityId}/${from.number}`,
    toId: `${to.identityId}/${to.number}`,
    instructionId,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();

const updateLegs = async (
  blockId: string,
  instructionId: string,
  settlementId: string
): Promise<void> => {
  const legs = await Leg.getByInstructionId(instructionId);

  await Promise.all(
    legs.map(leg => {
      leg.settlementId = settlementId;
      leg.updatedBlockId = blockId;
      leg.save();
    })
  );
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
    addresses: [address],
    createdBlockId: blockId,
    updatedBlockId: blockId,
  });
  await instruction.save();

  await Promise.all(
    legs.map((legDetails, index) => createLeg(blockId, instructionId, index, legDetails))
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
  params: Codec[],
  event: SubstrateEvent
): Promise<void> => {
  const address = getSignerAddress(event);

  const [, , rawInstructionId] = params;

  const instructionId = getTextValue(rawInstructionId);
  const instruction = await getInstruction(instructionId);

  if (address && !instruction.addresses.includes(address)) {
    instruction.addresses.push(address);
    instruction.updatedBlockId = blockId;
    await instruction.save();
  }
};

const handleInstructionFinalizedEvent = async (
  blockId: string,
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> => {
  const [, rawInstructionId] = params;
  const instructionId = getTextValue(rawInstructionId);
  const instruction = await getInstruction(instructionId);

  instruction.status = instructionResultMap[eventId] || instructionResultMap['default'];

  const address = getSignerAddress(event);

  if (address && !instruction.addresses.includes(address)) {
    instruction.addresses.push(address);
  }

  const settlementId = `${blockId}/${event.idx}`;
  const settlement = Settlement.create({
    id: settlementId,
    result: instruction.status,
    addresses: instruction.addresses,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  });

  await Promise.all([settlement.save(), instruction.save()]);

  if (eventId === EventIdEnum.InstructionExecuted) {
    await updateLegs(blockId, instructionId, settlementId);
  }
};

export async function mapSettlement({
  blockId,
  eventId,
  moduleId,
  params,
  event,
}: HandlerArgs): Promise<void> {
  if (moduleId === ModuleIdEnum.Settlement) {
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
      await handleInstructionUpdate(blockId, params, event);
    }

    if (finalizedEvents.includes(eventId)) {
      await handleInstructionFinalizedEvent(blockId, eventId, params, event);
    }
  }
}
