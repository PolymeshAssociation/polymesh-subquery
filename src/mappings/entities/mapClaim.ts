import { IssuerIdentityWithClaims } from "./../../types/models/IssuerIdentityWithClaims";
import { IdentityWithClaims } from "./../../types/models/IdentityWithClaims";
import { Codec } from "@polkadot/types/types";
import { SubstrateEvent } from "@subql/types";
import { ClaimScope } from "../../types/models/ClaimScope";
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
  claimExpiry: bigint;
  claimIssuer: string;
  claimScope: string;
  claimType: string;
  issuanceDate: bigint;
  lastUpdateDate: bigint;
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

    const claim = {
      targetDid,
      issuer: claimData.claimIssuer,
      issuanceDate: claimData.issuanceDate,
      lastUpdateDate: claimData.lastUpdateDate,
      expiry: claimData.claimExpiry,
      type: claimData.claimType,
      scope: JSON.parse(claimData.claimScope),
      jurisdiction,
      cddId: claimData.cddId,
    };

    const identityWithClaims = await IdentityWithClaims.get(targetDid);
    if (identityWithClaims) {
      identityWithClaims.claims.push(claim);
      await identityWithClaims.save();
    } else {
      await IdentityWithClaims.create({
        id: targetDid,
        did: targetDid,
        claims: [claim],
      }).save();
    }

    const issuerIdentityWithClaims = await IssuerIdentityWithClaims.get(
      targetDid
    );
    if (issuerIdentityWithClaims) {
      issuerIdentityWithClaims.claims.push(claim);
      await issuerIdentityWithClaims.save();
    } else {
      await IssuerIdentityWithClaims.create({
        id: claimData.claimIssuer,
        did: claimData.claimIssuer,
        claims: [claim],
      }).save();
    }

    if (scope) {
      handleScopes(
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
    handleScopes(targetDid, ticker);
  }
}

async function handleScopes(
  targetDid: string,
  ticker?: string,
  scope?: { type: string; value: string }
) {
  const id = `${targetDid}/${scope?.value || ticker}`;
  const scopeByDid = await ClaimScope.get(id);
  if (!scopeByDid) {
    await ClaimScope.create({
      id,
      targetDid,
      ticker,
      scope,
    }).save();
  }
}
