import { Codec } from "@polkadot/types/types";
import { SubstrateEvent } from "@subql/types";
import { Settlement, Instruction } from "../../types";
import { getSigner, getTextValue, hexToString, serializeTicker } from "../util";
import { EventIdEnum, ModuleIdEnum } from "./common";

enum SettlementResultEnum {
  None = "None",
  Executed = "Executed",
  Failed = "Failed",
  Rejected = "Rejected",
}

enum InstructionStatusEnum {
  Created = "Created",
  Executed = "Executed",
  Rejected = "Rejected",
  Failed = "Failed",
}

const updateEvents: EventIdEnum[] = [
  EventIdEnum.InstructionAuthorized,
  EventIdEnum.InstructionUnauthorized,
  EventIdEnum.InstructionAffirmed,
  EventIdEnum.InstructionFailed,
];

const finalizedEvents: EventIdEnum[] = [
  EventIdEnum.InstructionExecuted,
  EventIdEnum.InstructionRejected,
  EventIdEnum.InstructionFailed,
];

// Translates events into a settlements table. This inlcudes transfers between a users portfolio combined with completed Instructions.
export async function mapSettlement(
  blockId: number,
  eventId: EventIdEnum,
  moduleId: string,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> {
  if (
    moduleId === ModuleIdEnum.Portfolio &&
    eventId === EventIdEnum.MovedBetweenPortfolios
  ) {
    await handlePortfolioMovement(blockId, eventId, params, event);
  }

  if (moduleId === ModuleIdEnum.Settlement) {
    if (eventId === EventIdEnum.InstructionCreated) {
      await handleInstructionCreated(blockId, eventId, params, event);
    }

    if (updateEvents.includes(eventId)) {
      await handleInstructionUpdate(params, event);
    }

    if (finalizedEvents.includes(eventId)) {
      await handleInstructionFinalizedEvent(blockId, eventId, params, event);
    }
  }
}

async function handlePortfolioMovement(
  blockId: number,
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent
) {
  const signer = getSigner(event.extrinsic);
  const identityId = getTextValue(params[0]);
  const from = JSON.parse(params[1].toString());
  const to = JSON.parse(params[2].toString());
  const ticker = serializeTicker(params[3]);
  const amount = getTextValue(params[4]);

  const legs = [
    {
      ticker,
      amount,
      from: {
        did: from.did,
        number: from.kind.user ? from.kind.user.toString() : "0",
      },
      to: {
        did: to.did,
        number: to.kind.user ? to.kind.user.toString() : "0",
      },
    },
  ];
  const settlement = Settlement.create({
    id: `${blockId}/${event.idx}`,
    blockId,
    eventId,
    senderId: identityId,
    receiverId: identityId,
    ticker,
    amount,
    result: SettlementResultEnum.Executed,
    addresses: [signer],
    legs,
  });
  await settlement.save();
}

async function handleInstructionCreated(
  blockId: number,
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent
) {
  const signer = getSigner(event.extrinsic);

  const legs = [];
  const rawLegs = params[6].toJSON() as any;
  for (let i = 0; i < rawLegs.length; i++) {
    const leg = rawLegs[i];
    const { from, to, asset, amount } = leg;
    const serializedTicker = hexToString(asset);
    legs.push({
      ticker: serializedTicker,
      amount,
      from: {
        did: from.did,
        number: from.kind.user ? from.kind.user.toString() : "0",
      },
      to: {
        did: to.did,
        number: to.kind.user ? to.kind.user.toString() : "0",
      },
    });
  }
  const instruction = Instruction.create({
    id: getTextValue(params[2]),
    eventId,
    blockId,
    status: InstructionStatusEnum.Created,
    venueId: getTextValue(params[1]),
    settlementType: params[3] ? getTextValue(params[3]) : "",
    addresses: [signer],
    legs,
  });
  await instruction.save();
}

async function handleInstructionUpdate(params: Codec[], event: SubstrateEvent) {
  const signer = getSigner(event.extrinsic);
  const instructionId = getTextValue(params[2]);
  const instruction = await Instruction.get(instructionId);
  if (instruction) {
    instruction.addresses.push(signer);
    instruction.addresses = instruction.addresses.filter(onlyUnique);
    await instruction.save();
  } else {
    logger.error(`Could not find instruction by id: ${instructionId}`);
  }
}

async function handleInstructionFinalizedEvent(
  blockId: number,
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent
) {
  let signer: string;
  if (event.extrinsic) {
    signer = getSigner(event.extrinsic);
  }

  let result: SettlementResultEnum = SettlementResultEnum.None;

  if (eventId === EventIdEnum.InstructionExecuted)
    result = SettlementResultEnum.Executed;
  else if (eventId === EventIdEnum.InstructionRejected)
    result = SettlementResultEnum.Rejected;
  else if (eventId === EventIdEnum.InstructionFailed)
    result = SettlementResultEnum.Failed;

  const instructionId = getTextValue(params[1]);

  const instruction = await Instruction.get(instructionId);
  if (instruction) {
    instruction.status = result;
    if (signer) instruction.addresses.push(signer);
    instruction.addresses = instruction.addresses.filter(onlyUnique);
  } else {
    logger.error(`[FINAL] could not find instruction by id: ${instructionId}`);
  }

  const settlement = Settlement.create({
    id: `${blockId}/${event.idx}`,
    eventId,
    blockId,
    result,
    addresses: instruction.addresses,
    legs: instruction.legs,
  });
  await Promise.all([settlement.save(), instruction.save()]);
}

function onlyUnique(value: string, index: number, self: string[]) {
  return self.indexOf(value) === index;
}
