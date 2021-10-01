import { SubstrateEvent } from "@subql/types";
import { Codec } from "@polkadot/types/types";
import { EventIdEnum, ModuleIdEnum } from "./common";
import { Portfolio } from "../../types";
import { getTextValue } from "../util";

export async function mapPortfolio(
  blockId: number,
  eventId: EventIdEnum,
  moduleId: string,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> {
  if (moduleId === ModuleIdEnum.Identity) {
    if (eventId === EventIdEnum.DidCreated) {
      const did = getTextValue(params[0]);
      await Portfolio.create({
        id: `${did}/${0}`,
        blockId,
        eventId,
        identityId: did,
        number: 0,
        kind: "Default",
      }).save();
    }
  }

  if (moduleId === ModuleIdEnum.Portfolio) {
    if (eventId === EventIdEnum.PortfolioCreated) {
      const did = getTextValue(params[0]);
      const number = getTextValue(params[1]);
      await Portfolio.create({
        id: `${did}/${number}`,
        blockId,
        eventId,
        kind: "User",
        identityId: did,
        number,
        name: params[2].toString(),
      }).save();
    }

    if (eventId === EventIdEnum.PortfolioRenamed) {
      const portfolios = await Portfolio.getByIdentityId(params[0].toString());
      const portfolio = portfolios.find(
        (p) => p.number === getTextValue(params[1])
      );
      portfolio.name = getTextValue(params[2]);
      await portfolio.save();
    }

    if (eventId === EventIdEnum.PortfolioDeleted) {
      const portfolios = await Portfolio.getByIdentityId(
        getTextValue(params[0])
      );
      const portfolio = portfolios.find(
        (p) => p.number === getTextValue(params[1])
      );
      await Portfolio.remove(portfolio.id);
    }
  }
}

export async function findOrCreatePortfolio(
  did: string,
  number: string,
  blockId: number,
  eventId: EventIdEnum,
  eventIdx: number
): Promise<Portfolio> {
  let portfolio = (await Portfolio.getByIdentityId(did)).find(
    (p) => p.number === number
  );
  logger.info(`creating with did ${did}`);
  if (!portfolio) {
    portfolio = Portfolio.create({
      id: `${did}/${number}`,
      blockId,
      eventId,
      identityId: did,
      number,
      kind: number === "0" ? "Default" : "User",
    });
    await portfolio.save();
  }
  return portfolio;
}
