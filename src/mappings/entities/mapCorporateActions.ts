import { Codec } from "@polkadot/types/types";
import { SubstrateEvent } from "@subql/types";
import { getTextValue } from "../util";
import { HistoryOfPaymentEventsForCA } from "./../../types/models/HistoryOfPaymentEventsForCA";
import { WithholdingTaxesOfCA } from "./../../types/models/WithholdingTaxesOfCA";
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
  await HistoryOfPaymentEventsForCA.create({
    id: `${blockId}/${event.idx}`,
    blockId,
    eventId,
    eventIdx: event.idx,
    ticker: getTickerFromCaId(params, eventId),
    localId: getLocalIdFromCaId(params, eventId),
    balance: getBalanceForCa(params, eventId),
    tax: getTextValue(params[5]) || 0,
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
  const ticker = getTickerFromCaId(params, eventId);
  const localId = getLocalIdFromCaId(params, eventId);
  const balance = getBalanceForCa(params, eventId);
  const tax = getTextValue(params[5]) || 0;
  const corporateAction = await WithholdingTaxesOfCA.get(
    `${ticker}/${localId}`
  );
  if (corporateAction !== null) {
    corporateAction.taxes += (Number(balance) * Number(tax)) / 1000000;
    await corporateAction.save();
  } else {
    await WithholdingTaxesOfCA.create({
      id: `${ticker}/${localId}`,
      ticker: getTickerFromCaId(params, eventId),
      localId: getLocalIdFromCaId(params, eventId),
      taxes: getTextValue(params[5]) || 0,
      datetime: event.block.timestamp,
    }).save();
  }
}
