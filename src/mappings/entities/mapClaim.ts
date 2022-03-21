import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { getTextValue, serializeTicker } from '../util';
import { Claim } from '../../types/models/Claim';
import { ClaimScope } from '../../types/models/ClaimScope';
import { IdentityWithClaims } from '../../types/models/IdentityWithClaims';
import { IssuerIdentityWithClaims } from '../../types/models/IssuerIdentityWithClaims';
import { EventIdEnum, ModuleIdEnum } from './common';
import { Scope } from 'polymesh-subql/types';

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

const END_OF_TIME = BigInt('253402194600000');

function addIfNotIncludes<T>(arr: T[], item: T) {
  if (arr.includes(item)) {
    return;
  } else {
    arr.push(item);
  }
}

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
    const targetDid = getTextValue(params[0]);

    const scope = JSON.parse(claimScope);
    const filterExpiry = claimExpiry || END_OF_TIME;

    const args: IdentityWithClaimsArgs = {
      scope,
      filterExpiry,
      claimType,
      claimIssuer,
      targetDid,
    };

    await Promise.all([handleIdentityWithClaims(args), handleIssuerIdentityWithClaims(args)]);

    await Claim.create({
      id: `${blockId}/${event.idx}`,
      blockId,
      eventIdx: event.idx,
      targetDidId: targetDid,
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
        targetDid,
        scope.type === ClaimScopeTypeEnum.Ticker ? scope.value : null,
        scope
      );
    }
  }

  if (eventId === EventIdEnum.AssetDidRegistered) {
    const targetDid = getTextValue(params[0]);
    const ticker = serializeTicker(params[1]);
    await handleScopes(targetDid, ticker);
  }
}

type IdentityWithClaimsArgs = {
  targetDid: string;
  claimType: string;
  scope: Scope;
  claimIssuer: string;
  filterExpiry: bigint;
};

async function handleIdentityWithClaims({
  targetDid,
  claimIssuer,
  claimType,
  filterExpiry,
  scope,
}: IdentityWithClaimsArgs) {
  const identityWithClaims = await IdentityWithClaims.get(targetDid);
  if (identityWithClaims) {
    addIfNotIncludes(identityWithClaims.typeIndex, claimType);
    addIfNotIncludes(identityWithClaims.scopeIndex, scope);
    addIfNotIncludes(identityWithClaims.issuerIndex, claimIssuer);
    identityWithClaims.maxExpiry =
      filterExpiry > identityWithClaims.maxExpiry ? filterExpiry : identityWithClaims.maxExpiry;
    await identityWithClaims.save();
  } else {
    await IdentityWithClaims.create({
      id: targetDid,
      typeIndex: [claimType],
      scopeIndex: [scope],
      issuerIndex: [claimIssuer],
      maxExpiry: filterExpiry,
    }).save();
  }
}

async function handleIssuerIdentityWithClaims({
  targetDid,
  claimIssuer,
  claimType,
  filterExpiry,
  scope,
}: IdentityWithClaimsArgs) {
  const issuerIdentityWithClaims = await IssuerIdentityWithClaims.get(claimIssuer);
  if (issuerIdentityWithClaims) {
    addIfNotIncludes(issuerIdentityWithClaims.typeIndex, claimType);
    addIfNotIncludes(issuerIdentityWithClaims.scopeIndex, scope);
    addIfNotIncludes(issuerIdentityWithClaims.targetIndex, targetDid);
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
      targetIndex: [targetDid],
      maxExpiry: filterExpiry,
    }).save();
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
