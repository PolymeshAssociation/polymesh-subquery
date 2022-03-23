import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { Scope } from 'polymesh-subql/types';
import { Claim } from '../../types/models/Claim';
import { ClaimScope } from '../../types/models/ClaimScope';
import { IdentityWithClaims } from '../../types/models/IdentityWithClaims';
import { IssuerIdentityWithClaims } from '../../types/models/IssuerIdentityWithClaims';
import { addIfNotIncludes, END_OF_TIME, getTextValue, serializeTicker } from '../util';
import { EventIdEnum, ModuleIdEnum } from './common';

enum ClaimScopeTypeEnum {
  Identity = 'Identity',
  Ticker = 'Ticker',
  Custom = 'Custom',
}

type ClaimParams = {
  claimExpiry: bigint | undefined;
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
  {
    claimScope,
    claimExpiry,
    claimIssuer,
    claimType,
    issuanceDate,
    cddId,
    lastUpdateDate,
    jurisdiction,
  }: ClaimParams
): Promise<void> {
  if (moduleId !== ModuleIdEnum.Identity) {
    return;
  }
  if (eventId === EventIdEnum.ClaimAdded) {
    const target = getTextValue(params[0]);

    const scope = JSON.parse(claimScope);
    const filterExpiry = claimExpiry || END_OF_TIME;

    const args: IdentityWithClaimsArgs = {
      scope,
      filterExpiry,
      claimType,
      claimIssuer,
      target,
    };

    await Promise.all([handleIdentityWithClaims(args), handleIssuerIdentityWithClaims(args)]);

    await Claim.create({
      id: `${blockId}/${event.idx}`,
      blockId,
      eventIdx: event.idx,
      targetId: target,
      issuerId: claimIssuer,
      issuanceDate,
      lastUpdateDate,
      expiry: claimExpiry,
      type: claimType,
      scope,
      jurisdiction,
      cddId: cddId,
      filterExpiry,
    }).save();

    if (scope) {
      await handleScopes(
        target,
        scope.type === ClaimScopeTypeEnum.Ticker ? scope.value : null,
        scope
      );
    }
  }

  if (eventId === EventIdEnum.AssetDidRegistered) {
    const target = getTextValue(params[0]);
    const ticker = serializeTicker(params[1]);
    await handleScopes(target, ticker);
  }
}

type IdentityWithClaimsArgs = {
  target: string;
  claimType: string;
  scope: Scope;
  claimIssuer: string;
  filterExpiry: bigint;
};

async function handleIdentityWithClaims({
  target,
  claimIssuer,
  claimType,
  filterExpiry,
  scope,
}: IdentityWithClaimsArgs) {
  const identityWithClaims = await IdentityWithClaims.get(target);
  if (identityWithClaims) {
    addIfNotIncludes(identityWithClaims.typeIndex, claimType);
    addIfNotIncludes(identityWithClaims.scopeIndex, scope);
    addIfNotIncludes(identityWithClaims.issuerIndex, claimIssuer);
    identityWithClaims.maxExpiry =
      filterExpiry > identityWithClaims.maxExpiry ? filterExpiry : identityWithClaims.maxExpiry;
    await identityWithClaims.save();
  } else {
    await IdentityWithClaims.create({
      id: target,
      typeIndex: [claimType],
      scopeIndex: [scope],
      issuerIndex: [claimIssuer],
      maxExpiry: filterExpiry,
    }).save();
  }
}

async function handleIssuerIdentityWithClaims({
  target,
  claimIssuer,
  claimType,
  filterExpiry,
  scope,
}: IdentityWithClaimsArgs) {
  const issuerIdentityWithClaims = await IssuerIdentityWithClaims.get(claimIssuer);
  if (issuerIdentityWithClaims) {
    addIfNotIncludes(issuerIdentityWithClaims.typeIndex, claimType);
    addIfNotIncludes(issuerIdentityWithClaims.scopeIndex, scope);
    addIfNotIncludes(issuerIdentityWithClaims.targetIndex, target);
    issuerIdentityWithClaims.maxExpiry =
      filterExpiry > issuerIdentityWithClaims.maxExpiry
        ? filterExpiry
        : issuerIdentityWithClaims.maxExpiry;
    await issuerIdentityWithClaims.save();
  } else {
    await IssuerIdentityWithClaims.create({
      id: claimIssuer,
      typeIndex: [claimType],
      scopeIndex: [scope],
      targetIndex: [target],
      maxExpiry: filterExpiry,
    }).save();
  }
}

async function handleScopes(
  target: string,
  ticker?: string,
  scope?: { type: string; value: string }
) {
  const id = `${target}/${scope?.value || ticker}`;
  await ClaimScope.create({
    id,
    target,
    ticker,
    scope,
  }).save();
}
