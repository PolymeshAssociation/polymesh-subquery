import { Codec } from "@polkadot/types/types";
import { hexStripPrefix } from "@polkadot/util";
import { SubstrateEvent } from "@subql/types";
import { Settlement, Instruction, Leg } from "../../types";
import { getSigner, getTextValue, hex2a, serializeTicker } from "../util";
import { EventIdEnum, ModuleIdEnum } from "./common";
import { findOrCreateIdentity } from "./mapIdentity";
import { findOrCreatePortfolio } from "./mapPortfolio";

// A settlement is an asset moved between portofolios or a leg of a completed instruction

// A settlement is a movement of an asset. This can be from completed instructions and from portfolio movements

// Each event needs to update two accounts / identities (incoming / outgoing)
// If each account optionally provides an portfolio
// Might need an identity handler as well
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
// In addition we need to track transfers between a users portfolio as well
// Translates events into a settlements table. This inlcudes transfers between a users portfolio combined with completed settlements between accounts.
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

  // if (moduleId === ModuleIdEnum.Settlement) {
  //   if (eventId === EventIdEnum.InstructionCreated) {
  //     await handleInstructionCreated(blockId, eventId, params, event);
  //   }

  //   if (updateEvents.includes(eventId)) {
  //     await handleInstructionUpdate(params, event);
  //   }

  //   if (finalizedEvents.includes(eventId)) {
  //     await handleInstructionFinalizedEvent(blockId, eventId, params, event);
  //   }
  // }
}

async function handlePortfolioMovement(
  blockId: number,
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent
) {
  logger.info("Portfolio movement event");
  const signer = getSigner(event.extrinsic);
  const identityId = getTextValue(params[0]);
  const from = JSON.parse(params[1].toString());
  const to = JSON.parse(params[2].toString());
  const ticker = serializeTicker(params[3]);
  const amount = getTextValue(params[4]);
  logger.info(`human params[1]: ${params[1].toHuman()}`);
  logger.info(`from: ${from} , falsy? ${!!from}`);
  logger.info(`raw from: ${from.toString()} , falsy? ${!!from}`);
  logger.info(`raw to: ${to.toString()}`);

  // const fromPorfolio = await findOrCreatePortfolio(
  //   from.did,
  //   from.kind.user ? from.kind.user : "0",
  //   blockId,
  //   eventId,
  //   event.idx
  // );
  // const toPortfolio = await findOrCreatePortfolio(
  //   to.did,
  //   to.kind.user ? to.kind.user : "0",
  //   blockId,
  //   eventId,
  //   event.idx
  // );

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
  });
  await settlement.save();
  // TODO need to get the from + to portfolios
  const fromId = `${identityId}/${from.user.number || "0"}`;
  const toId = `${identityId}/${to.user.number || "0"}`;
  await Leg.create({
    id: `${blockId}/${event.idx}`,
    blockId,
    eventId,
    ticker,
    amount,
    settlementId: settlement.id,
    fromId,
    toId,
  }).save();
}

async function handleInstructionCreated(
  blockId: number,
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent
) {
  logger.info("create event");
  logger.info(`block id: ${blockId}`);
  const signer = getSigner(event.extrinsic);

  const instruction = Instruction.create({
    id: getTextValue(params[2]),
    eventId,
    blockId,
    status: InstructionStatusEnum.Created,
    venueId: getTextValue(params[1]),
    settlementType: params[3] ? getTextValue(params[3]) : "",
    tradeDate: params[4] ? getTextValue(params[4]) : "",
    valueDate: params[5] ? getTextValue(params[5]) : "",
    addresses: [signer],
  });
  await instruction.save();

  // store the instructions legs
  const legs = params[6].toJSON() as any;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const { from, to, asset, amount } = leg;
    const fromDid = getTextValue(from.did);
    const toDid = getTextValue(to.did);
    const decoddeAsset = hex2a(hexStripPrefix(asset));
    let fromPortfolioNumber = "0";
    if (from.kind === "User") {
      fromPortfolioNumber = from.kind.User.toString();
    }
    let toPortfolioNumber = "0";
    if (to.kind === "User") {
      toPortfolioNumber = to.kind.User.toString()();
    }

    // Find or create is needed to deal with address prebaked into the chain like "0x0500000000000000000000000000000000000000000000000000000000000000"
    await findOrCreateIdentity(fromDid, blockId, eventId);
    const fromPorfolio = await findOrCreatePortfolio(
      fromDid,
      fromPortfolioNumber,
      blockId,
      eventId,
      event.idx
    );
    await findOrCreateIdentity(toDid, blockId, eventId);
    const toPortfolio = await findOrCreatePortfolio(
      toDid,
      toPortfolioNumber,
      blockId,
      eventId,
      event.idx
    );

    await Leg.create({
      id: `${blockId}/${event.idx}-${i}`,
      eventId,
      blockId,
      ticker: decoddeAsset,
      instructionId: instruction.id,
      amount: amount ? getTextValue(amount) : "unknown",
      fromId: fromPorfolio.id,
      toId: toPortfolio.id,
    })
      .save()
      .catch((err) => logger.error(err));
  }
}

async function handleInstructionUpdate(params: Codec[], event: SubstrateEvent) {
  logger.info("Instruction update event received");
  const signer = getSigner(event.extrinsic);
  const instructionId = getTextValue(params[2]);
  const instruction = await Instruction.get(instructionId);
  if (instruction) {
    instruction.addresses.push(signer);
    instruction.addresses = instruction.addresses.filter(onlyUnique);
    await instruction.save();
  } else {
    logger.error(`[UPDATE] could not find instruction by id: ${instructionId}`);
  }
}

async function handleInstructionFinalizedEvent(
  blockId: number,
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent
) {
  logger.info("Received finalized event");
  let signer;
  if (event.extrinsic) {
    // might not be present on any
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
  const legs = await Leg.getByInstructionId(instructionId);

  const instruction = await Instruction.get(instructionId);
  if (instruction) {
    instruction.status = result;
    if (signer) instruction.addresses.push(signer);
    instruction.addresses = instruction.addresses.filter(onlyUnique);
    await instruction.save();
  } else {
    logger.error(`[FINAL] could not find instruction by id: ${instructionId}`);
  }

  logger.info(
    `updating ${legs.length} legs from instruction id ${instructionId}`
  );
  legs.forEach(async (leg, i) => {
    const settlement = Settlement.create({
      id: `${blockId}/${event.idx}-${i}`,
      eventId,
      blockId,
      result,
      ticker: leg.ticker,
      // need to take off portfolio suffix /number
      senderId: leg.fromId ? leg.fromId.replace(/\/\d+/, "") : null,
      receiverId: leg.toId ? leg.toId.replace(/\/\d+/, "") : null,
      addresses: instruction.addresses,
    });
    await settlement.save();
    leg.settlementId = settlement.id;
    await leg.save();
  });
}

function onlyUnique(value, index, self) {
  return self.indexOf(value) === index;
}
