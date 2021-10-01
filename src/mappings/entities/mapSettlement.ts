import { Codec } from "@polkadot/types/types";
import { SubstrateEvent } from "@subql/types";
import { Settlement, Instruction, Leg } from "../../types";
import { getTextValue, serializeTicker } from "../util";
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

  if (moduleId === ModuleIdEnum.Settlement) {
    logger.info("settlement event: ");
    logger.info(eventId);

    if (eventId === EventIdEnum.InstructionCreated) {
      await handleInstructionCreated(blockId, eventId, params, event);
    }

    if (updateEvents.includes(eventId)) {
      await handleInstructionUpdate(params);
    }

    if (finalizedEvents.includes(eventId)) {
      await handleFinalizedEvent(blockId, eventId, params, event);
    }
  }
}

async function handlePortfolioMovement(
  blockId: number,
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent
) {
  // logger.info("Portfolio params");
  // logger.info(params[0].toString()); // identity 0xc5e2d554233da63d509ee482dbeed0ddec94dc1d0b45ebfdcdc48bd0928222b1
  // logger.info(params[1].toJSON()); // source undefined
  // logger.info(params[2].toJSON()); // destination undefined
  // logger.info(params[3].toHuman()); // ticker 0x345449434b45520000000000
  // logger.info(params[4].toString()); // amount 100
  // logger.info(params[5].toHuman()); // memo null
  const identityId = getTextValue(params[0]);
  const from = params[1].toJSON();
  const to = params[2].toJSON();
  const ticker = serializeTicker(params[3]);
  const amount = getTextValue(params[4]);

  // const fromPorfolio = await findOrCreatePortfolio(
  //   from.did,
  //   "0",
  //   blockId,
  //   eventId,
  //   event.idx
  // );
  // const toPortfolio = await findOrCreatePortfolio(
  //   to.did,
  //   "0",
  //   blockId,
  //   eventId,
  //   event.idx,
  // )
  const addresses = [];

  // address for address filter?
  const settlement = Settlement.create({
    id: `${blockId}/${event.idx}`,
    blockId,
    eventId,
    identityId,
    from,
    to,
    ticker,
    amount,
    addresses,
    result: SettlementResultEnum.Executed,
    // sender:
    // receiver
  });
  await settlement.save();
  await Leg.create({
    id: `${blockId}/${event.idx}`,
    blockId,
    eventId,
    identityId,
    ticker,
    from,
    to,
    amount,
    settlementId: settlement.id,
  }).save();
}

async function handleInstructionCreated(
  blockId: number,
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent
) {
  // (did, venue_id, instruction_id, settlement_type, trade_date, value_date, legs)
  // logger.info("Create Instruction params");
  // logger.info(params[0].toHuman()); // 0x0500000000000000000000000000000000000000000000000000000000000000
  // logger.info(params[1].toHuman()); // 7
  // logger.info(params[2].toHuman()); // 6
  // logger.info(params[3].toHuman()); // undefined
  // logger.info(params[4].toHuman()); // null
  // logger.info(params[5].toHuman()); // null
  // logger.info(params[6].toString()); // //undefined legs
  const legs = params[6].toJSON() as any;
  const instruction = Instruction.create({
    id: getTextValue(params[2]),
    eventId,
    blockId,
    status: InstructionStatusEnum.Created,
    venueId: getTextValue(params[1]),
    settlementType: params[3] ? getTextValue(params[3]) : "",
    tradeDate: params[4] ? getTextValue(params[4]) : "",
    valueDate: params[5] ? getTextValue(params[5]) : "",
    addresses: [],
  });
  await instruction.save();
  const modelLegs = [];
  legs.forEach(async (leg, i) => {
    const { from, to, asset, amount } = leg;

    let fromPortfolioNumber = "0";
    if (from.kind === "User") {
      fromPortfolioNumber = from.kind.User.toString();
    }
    let toPortfolioNumber = "0";
    if (to.kind === "User") {
      toPortfolioNumber = to.kind.User.toString()();
    }
    logger.info(`from did ${from.did} to did ${to.did}`);
    // Find or create is needed to deal with address prebaked into the chain like "0x0500000000000000000000000000000000000000000000000000000000000000"
    // Its probably better to prebake these into the DB then slowing down indexing with excessive DB calls
    // const fromId = await findOrCreateIdentity(from.did, blockId, eventId);
    // logger.info("made from id:");
    // const fromPorfolio = await findOrCreatePortfolio(
    //   from.did,
    //   fromPortfolioNumber,
    //   blockId,
    //   eventId,
    //   event.idx
    // );
    // logger.info("made from portfolio");
    // const toId = await findOrCreateIdentity(to.did, blockId, eventId);
    // logger.info("made to id");
    // const toPortfolio = await findOrCreatePortfolio(
    //   to.did,
    //   toPortfolioNumber,
    //   blockId,
    //   eventId,
    //   event.idx
    // );
    // logger.info("made to portfolio");

    // if (!toPortfolio) {
    //   logger.error(
    //     `to portfolio was not found for did ${to.did}, number: ${toPortfolioNumber}`
    //   );
    // }

    // if (!fromPorfolio) {
    //   logger.error(
    //     `from portfolio was not found for did ${from.did}, number: ${fromPortfolioNumber}`
    //   );
    // }

    logger.info("saving instruction created leg");
    // logger.info(`from: ${fromPorfolio.id}`);
    // logger.info(`to: ${toPortfolio.id}`);
    modelLegs.push(
      Leg.create({
        id: `${blockId}/${event.idx}-${i}`,
        eventId,
        blockId,
        ticker: asset || "unknown",
        instructionId: instruction.id,
        amount: amount ? amount : "unknown",
        // sender:
        // receiver:
      })
    );
  });
  await Promise.all(modelLegs.map((l) => l.save())).catch((e) => {
    logger.error("error creating leg");
    logger.error(e);
    logger.error(e.sql);
  });
}

async function handleInstructionUpdate(params: Codec[]) {
  logger.info("Instruction update event received");
  // logger.info("Instruction params");
  // logger.info(`${params[0].toHuman()}`);
  // logger.info(`${params[1].toHuman()}`);
  // logger.info(`${params[2].toHuman()}`);
  const instructionId = getTextValue(params[2]);
  const instruction = await Instruction.get(instructionId);
  if (instruction) {
    instruction.addresses.push(getTextValue(params[0])); // maybe portfolio from params[1]
    await instruction.save();
  } else {
    logger.error(`[UPDATE] could not find instruction by id: ${instructionId}`);
  }
}

async function handleFinalizedEvent(
  blockId: number,
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent
) {
  // logger.info("Received finalized event");
  let result: SettlementResultEnum = SettlementResultEnum.None;

  if (eventId === EventIdEnum.InstructionExecuted)
    result = SettlementResultEnum.Executed;
  else if (eventId === EventIdEnum.InstructionRejected)
    result = SettlementResultEnum.Rejected;
  else if (eventId === EventIdEnum.InstructionFailed)
    result = SettlementResultEnum.Failed;

  const identityId = params[0].toString();
  const instructionId = params[1].toString();
  // logger.info("Finalized params (id, instructionId)");
  // logger.info(params[0].toHuman());
  // logger.info(params[1].toHuman());
  // logger.info(`Instruction id: ${instructionId}`);
  const legs = await Leg.getByInstructionId(instructionId);

  const instruction = await Instruction.get(instructionId);
  if (instruction) {
    instruction.status = result;
    await instruction.save();
  } else {
    logger.error(`[FINAL] could not find instruction by id: ${instructionId}`);
  }

  logger.info("updating legs");
  logger.info(legs.length);
  legs.forEach(async (leg, i) => {
    logger.info(`loop ${i} making settlement + leg`);
    const settlement = Settlement.create({
      id: `${blockId}/${event.idx}-${i}`,
      eventId,
      blockId,
      result,
      identityId,
      ticker: leg.ticker,
      // sender: leg.fromId,
      // receiver: leg.toId,
    });
    await settlement.save();
    leg.settlementId = settlement.id;
    logger.info(`saving leg for settlement id: ${settlement.id}`);
    await leg.save();
  });
}
