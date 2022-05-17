import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { Claim } from '../../types/models/Claim';
import { ClaimScope } from '../../types/models/ClaimScope';
import { END_OF_TIME, getTextValue, serializeTicker } from '../util';
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

type Scope = {
  type: ClaimScopeTypeEnum;
  value: string;
};

const getId = (
  target: string,
  claimType: string,
  scope: Scope,
  jurisdiction: string,
  cddId: string
): string => {
  const idAttributes = [target, claimType];
  if (scope) {
    // Not applicable in case of CustomerDueDiligence
    idAttributes.push(scope.type);
    idAttributes.push(scope.value);
  }
  if (jurisdiction) {
    // Only applicable in case of claim type Jurisdiction
    idAttributes.push(jurisdiction);
  }
  if (cddId) {
    // Only applicable in case of CustomerDueDiligence
    idAttributes.push(cddId);
  }
  return idAttributes.join('/');
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
  const target = getTextValue(params[0]);

  const scope = JSON.parse(claimScope) as Scope;

  if (eventId === EventIdEnum.ClaimAdded) {
    const filterExpiry = claimExpiry || END_OF_TIME;

    await Claim.create({
      id: getId(target, claimType, scope, jurisdiction, cddId),
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
      cddId,
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

  if (eventId === EventIdEnum.ClaimRevoked) {
    const id = getId(target, claimType, scope, jurisdiction, cddId);
    const claim = await Claim.get(id);
    if (!claim) {
      throw new Error(`Claim with id ${id} was not found`);
    }
    claim.revokeDate = issuanceDate;
    await claim.save();
  }

  if (eventId === EventIdEnum.AssetDidRegistered) {
    const ticker = serializeTicker(params[1]);
    await handleScopes(target, ticker);
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
