import { Codec } from "@polkadot/types/types";
import { SubstrateEvent } from "@subql/types";
import { getTextValue } from "../util";
import { HistoryOfPaymentEventsForCa } from "./../../types/models/HistoryOfPaymentEventsForCa";
import { WithholdingTaxesOfCa } from "./../../types/models/WithholdingTaxesOfCa";
import { serializeTicker } from "./../util";
import { EventIdEnum, ModuleIdEnum } from "./common";

type CapitalDistributionParams = (
  params: Codec[],
  eventId: EventIdEnum
) => Promise<string>;

const getBalanceForCa: CapitalDistributionParams = async (params, eventId) => {
  if (eventId === EventIdEnum.BenefitClaimed) {
    return getTextValue(params[4]);
  }
  if (eventId === EventIdEnum.Reclaimed) {
    return getTextValue(params[2]);
  }
  throw new Error("Event didn't have a balance parameter");
};

const getTickerFromCaId: CapitalDistributionParams = async (
  params,
  eventId
) => {
  if (eventId === EventIdEnum.BenefitClaimed) {
    if (params[2] instanceof Map && params[2].get("ticker")) {
      return serializeTicker(params[2].get("ticker"));
    }
  } else if (eventId === EventIdEnum.Reclaimed) {
    if (params[1] instanceof Map && params[1].get("ticker")) {
      return serializeTicker(params[1].get("ticker"));
    }
  }
  throw new Error("Event didn't have a ticker parameter within Ca_Id");
};

const getLocalIdFromCaId: CapitalDistributionParams = async (
  params,
  eventId
) => {
  if (eventId === EventIdEnum.BenefitClaimed) {
    if (params[2] instanceof Map && params[2].get("local_id")) {
      return getTextValue(params[2].get("local_id"));
    }
  } else if (eventId === EventIdEnum.Reclaimed) {
    if (params[1] instanceof Map && params[1].get("local_id")) {
      return getTextValue(params[1].get("local_id"));
    }
  }
  throw new Error("Event didn't have a CaID local_id parameter within Ca_Id");
};

/**
 * Subscribes to the CapitalDistribution (BenefitedClaimed and Reclaimed Event)
 */
export async function mapCorporateActions(
  blockId: number,
  eventId: EventIdEnum,
  moduleId: ModuleIdEnum,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> {
  if (moduleId === ModuleIdEnum.Capitaldistribution) {
    if (eventId === EventIdEnum.BenefitClaimed) {
      await handleHistoryOfPaymentEventsForCA(blockId, eventId, params, event);
      await handleWithholdingTaxesOfCA(eventId, params, event);
    }
    if (eventId === EventIdEnum.Reclaimed) {
      await handleHistoryOfPaymentEventsForCA(blockId, eventId, params, event);
    }
  }
}

/**
 * Handles HistoryOfPaymentEventsForCA entity
 */
async function handleHistoryOfPaymentEventsForCA(
  blockId: number,
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent
) {
  const eventDid = getTextValue(params[0]);
  const ticker = await getTickerFromCaId(params, eventId);
  const localId = await getLocalIdFromCaId(params, eventId);
  const balance = await getBalanceForCa(params, eventId);
  const tax = (await getTextValue(params[5])) || 0;
  await HistoryOfPaymentEventsForCa.create({
    id: `${blockId}/${event.idx}`,
    blockId,
    eventId,
    eventDid,
    eventIdx: event.idx,
    ticker,
    localId,
    balance,
    tax,
    datetime: event.block.timestamp,
  }).save();
}

/**
 * Handles WithholdingTaxesOfCA entity
 * This method is executed for only BenefitClaimed event.
 * On receiving this event, it calculates the tax for the specific event and
 * aggregates it to the existing value against CaId(localId + Ticker)
 */
async function handleWithholdingTaxesOfCA(
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent
) {
  const ticker = await getTickerFromCaId(params, eventId);
  const localId = await getLocalIdFromCaId(params, eventId);
  const balance = await getBalanceForCa(params, eventId);
  const tax = (await getTextValue(params[5])) || 0;
  const taxes = (Number(balance) * Number(tax)) / 1000000;
  const corporateAction = await WithholdingTaxesOfCa.get(
    `${ticker}/${localId}`
  );
  if (corporateAction !== undefined) {
    corporateAction.taxes += taxes;
    await corporateAction.save();
  } else {
    await WithholdingTaxesOfCa.create({
      id: `${ticker}/${localId}`,
      ticker,
      localId,
      taxes,
      datetime: event.block.timestamp,
    }).save();
  }
}