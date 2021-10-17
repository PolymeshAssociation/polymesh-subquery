import { Codec } from "@polkadot/types/types";
import { SubstrateEvent } from "@subql/types";
import { Claim } from "../../types/models/Claim";
import { ClaimScope } from "../../types/models/ClaimScope";
import { IdentityWithClaims } from "../../types/models/IdentityWithClaims";
import { getTextValue, serializeTicker } from "../util";
import { EventIdEnum, ModuleIdEnum } from "./common";

const claimEvents = new Set<string>([
  EventIdEnum.ClaimAdded,
  EventIdEnum.ClaimRevoked,
]);

const isClaimEvent = (e: string): e is EventIdEnum => claimEvents.has(e);

export enum ClaimScopeTypeEnum {
  Identity = "Identity",
  Ticker = "Ticker",
  Custom = "Custom",
}

export enum ClaimTypeEnum {
  Accredited = "Accredited",
  Affiliate = "Affiliate",
  BuyLockup = "BuyLockup",
  SellLockup = "SellLockup",
  CustomerDueDiligence = "CustomerDueDiligence",
  KnowYourCustomer = "KnowYourCustomer",
  Jurisdiction = "Jurisdiction",
  Exempted = "Exempted",
  Blocked = "Blocked",
  InvestorUniqueness = "InvestorUniqueness",
  NoData = "NoData",
  InvestorUniquenessV2 = "InvestorUniquenessV2",
}

type ClaimParams = {
  claimExpiry: string;
  claimIssuer: string;
  claimScope: string;
  claimType: string;
  issuanceDate: BigInt;
  lastUpdateDate: BigInt;
  cddId: string;
};

/**
 * Subscribes to the Claim events
 */
export async function mapClaim(
  blockId: number,
  eventId: EventIdEnum,
  moduleId: ModuleIdEnum,
  params: Codec[],
  event: SubstrateEvent,
  claimData: ClaimParams
): Promise<void> {
  if (moduleId === ModuleIdEnum.Identity && isClaimEvent(eventId)) {
    let jurisdiction;
    if (claimData.claimType === ClaimTypeEnum.Jurisdiction) {
      const col1: string = JSON.parse(claimData.claimScope).col1;
      jurisdiction = col1.substring(0, 2);
    }

    const targetDid = getTextValue(params[0]);

    const scope = JSON.parse(claimData.claimScope);

    const identityWithClaims = await IdentityWithClaims.get(targetDid);
    if (!identityWithClaims) {
      await IdentityWithClaims.create({
        id: targetDid,
        did: targetDid,
      }).save();
    }

    await Claim.create({
      id: `${blockId}/${event.idx}`,
      blockId,
      targetDid,
      issuer: claimData.claimIssuer,
      issuanceDate: claimData.issuanceDate,
      lastUpdateDate: claimData.lastUpdateDate,
      expiry: claimData.claimExpiry,
      type: claimData.claimType,
      scope: JSON.parse(claimData.claimScope),
      jurisdiction,
      cddId: claimData.cddId,
      identityWithClaimId: targetDid,
    }).save();

    if (scope) {
      handleScopes(
        blockId,
        event,
        targetDid,
        scope.type === ClaimScopeTypeEnum.Ticker ? scope.value : null,
        scope
      );
    }
  }

  if (
    moduleId === ModuleIdEnum.Identity &&
    eventId === EventIdEnum.AssetDidRegistered
  ) {
    const targetDid = getTextValue(params[0]);
    const ticker = serializeTicker(params[1]);
    handleScopes(blockId, event, targetDid, ticker);
  }
}

async function handleScopes(
  blockId: number,
  event: SubstrateEvent,
  targetDid: string,
  ticker?: string,
  scope?: { type: string; value: string }
) {
  await ClaimScope.create({
    id: `${blockId}/${event.idx}`,
    targetDid,
    ticker,
    scope,
  }).save();
}
