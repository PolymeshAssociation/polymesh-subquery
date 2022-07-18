import { SubstrateEvent } from '@subql/types';
import {
  Claim,
  ClaimScope,
  ClaimTypeEnum,
  ClaimScopeTypeEnum,
  EventIdEnum,
  ModuleIdEnum,
} from '../../types';
import { END_OF_TIME, getTextValue, serializeTicker } from '../util';
import { HandlerArgs } from './common';

interface ClaimParams {
  claimExpiry: bigint | undefined;
  claimIssuer: string;
  claimScope: string;
  claimType: ClaimTypeEnum;
  issuanceDate: bigint;
  lastUpdateDate: bigint;
  cddId: string;
  jurisdiction: string;
}

interface Scope {
  type: ClaimScopeTypeEnum;
  value: string;
}

/**
 * Subscribes to the Claim events
 */
export async function mapClaim(
  { blockId, eventId, moduleId, params, event }: HandlerArgs,
  claimParams: ClaimParams
): Promise<void> {
  if (moduleId === ModuleIdEnum.identity) {
    const target = getTextValue(params[0]);

    if (eventId === EventIdEnum.ClaimAdded) {
      await handleClaimAdded(blockId, event, claimParams, target);
    }

    if (eventId === EventIdEnum.ClaimRevoked) {
      await handleClaimRevoked(target, claimParams);
    }

    if (eventId === EventIdEnum.AssetDidRegistered) {
      const ticker = serializeTicker(params[1]);
      await handleScopes(blockId, target, ticker);
    }
  }
}

const getId = (
  target: string,
  claimType: string,
  scope: Scope,
  jurisdiction: string,
  cddId: string
): string => {
  const idAttributes = [target, claimType];
  if (scope) {
    // Not applicable in case of CustomerDueDiligence, InvestorUniquenessV2Claim, NoData claim types
    idAttributes.push(scope.type);
    idAttributes.push(scope.value);
  }
  if (jurisdiction) {
    // Only applicable in case of Jurisdiction claim type
    idAttributes.push(jurisdiction);
  }
  if (cddId) {
    // Only applicable in case of CustomerDueDiligence claim type
    idAttributes.push(cddId);
  }
  return idAttributes.join('/');
};

const handleClaimAdded = async (
  blockId: string,
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
  }: ClaimParams,
  target: string
): Promise<void> => {
  const scope = JSON.parse(claimScope) as Scope;

  const filterExpiry = claimExpiry || END_OF_TIME;

  await Claim.create({
    id: getId(target, claimType, scope, jurisdiction, cddId),
    eventIdx: event.idx,
    targetId: target,
    issuerId: claimIssuer,
    issuanceDate,
    lastUpdateDate,
    expiry: claimExpiry,
    type: claimType,
    scope,
    jurisdiction,
    cddId,
    filterExpiry,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();

  if (scope) {
    await handleScopes(
      blockId,
      target,
      scope.type === ClaimScopeTypeEnum.Ticker ? scope.value : null,
      scope
    );
  }
};

const handleClaimRevoked = async (
  target: string,
  { claimScope, claimType, issuanceDate, cddId, jurisdiction }: ClaimParams
) => {
  const scope = JSON.parse(claimScope) as Scope;

  const id = getId(target, claimType, scope, jurisdiction, cddId);

  const claim = await Claim.get(id);
  if (!claim) {
    throw new Error(`Claim with id ${id} was not found`);
  }

  claim.revokeDate = issuanceDate;

  await claim.save();
};

const handleScopes = async (
  blockId: string,
  target: string,
  ticker?: string,
  scope?: Scope
): Promise<void> => {
  const id = `${target}/${scope?.value || ticker}`;
  await ClaimScope.create({
    id,
    target,
    ticker,
    scope,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};
