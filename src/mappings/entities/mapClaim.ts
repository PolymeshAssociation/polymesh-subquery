import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { getTextValue, serializeTicker } from '../util';
import { Claim } from './../../types/models/Claim';
import { ClaimScope } from './../../types/models/ClaimScope';
import { IdentityWithClaims } from './../../types/models/IdentityWithClaims';
import { IssuerIdentityWithClaims } from './../../types/models/IssuerIdentityWithClaims';
import { EventIdEnum, ModuleIdEnum } from './common';

const claimEvents = new Set<string>([EventIdEnum.ClaimAdded, EventIdEnum.ClaimRevoked]);

const isClaimEvent = (e: string): e is EventIdEnum => claimEvents.has(e);

enum ClaimScopeTypeEnum {
  Identity = 'Identity',
  Ticker = 'Ticker',
  Custom = 'Custom',
}

type ClaimParams = {
  claimExpiry: bigint;
  claimIssuer: string;
  claimScope: string;
  claimType: string;
  issuanceDate: bigint;
  lastUpdateDate: bigint;
  cddId: string;
  jurisdiction: string;
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
      jurisdiction: claimData.jurisdiction,
      cddId: claimData.cddId,
    };

    await Claim.create({
      id: `${blockId}/${event.idx}`,
      ...claim,
      filterExpiry: claimData.claimExpiry || '253402194600000',
    }).save();

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

    const issuerIdentityWithClaims = await IssuerIdentityWithClaims.get(claimData.claimIssuer);
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
      await handleScopes(
        targetDid,
        scope.type === ClaimScopeTypeEnum.Ticker ? scope.value : null,
        scope
      );
    }
  }

  if (moduleId === ModuleIdEnum.Identity && eventId === EventIdEnum.AssetDidRegistered) {
    const targetDid = getTextValue(params[0]);
    const ticker = serializeTicker(params[1]);
    await handleScopes(targetDid, ticker);
  }
}

async function handleScopes(
  targetDid: string,
  ticker?: string,
  scope?: { type: string; value: string }
) {
  const id = `${targetDid}/${scope?.value || ticker}`;
  await ClaimScope.create({
    id,
    targetDid,
    ticker,
    scope,
  }).save();
}
