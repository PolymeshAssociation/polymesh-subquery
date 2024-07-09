import { GenericEvent } from '@polkadot/types/generic';
import { SubstrateEvent } from '@subql/types';
import { Claim, ClaimScope, ClaimScopeTypeEnum, ClaimTypeEnum, EventIdEnum } from '../../types';
import {
  END_OF_TIME,
  extractClaimInfo,
  getTextValue,
  logFoundType,
  serializeTicker,
} from '../../utils';
import { serializeLikeHarvester } from '../serializeLikeHarvester';
import { extractArgs } from './common';
import { createIdentityIfNotExists } from './mapIdentities';

const extractHarvesterArgs = (event: SubstrateEvent) => {
  const genericEvent = event.event as GenericEvent;
  const args = genericEvent.data;

  return args.map((arg, i) => {
    let type;
    const typeName = genericEvent.meta.fields[i].typeName;
    if (typeName.isSome) {
      // for metadata >= v14
      type = typeName.unwrap().toString();
    } else {
      // for metadata < v14
      type = genericEvent.meta.args[i].toString();
    }
    return {
      value: serializeLikeHarvester(arg, type, logFoundType),
    };
  });
};

interface Scope {
  type: ClaimScopeTypeEnum;
  value: string;
}

const getId = (
  target: string,
  claimType: string,
  scope: Scope,
  jurisdiction: string,
  cddId: string,
  customClaimTypeId: string | undefined
): string => {
  const idAttributes = [target, claimType];

  if (customClaimTypeId) {
    idAttributes.push(customClaimTypeId);
  }

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

export const handleClaimAdded = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, eventIdx, block, params } = extractArgs(event);
  const harvesterArgs = extractHarvesterArgs(event);
  const target = getTextValue(params[0]);

  const {
    claimExpiry,
    claimIssuer,
    claimScope,
    claimType,
    issuanceDate,
    lastUpdateDate,
    cddId,
    jurisdiction,
    customClaimTypeId,
  } = extractClaimInfo(harvesterArgs);

  const scope = JSON.parse(claimScope) as Scope;

  const filterExpiry = claimExpiry || END_OF_TIME;

  // The `target` for any claim is not validated, so we make sure it is present in `identities` table
  await createIdentityIfNotExists(target, blockId, EventIdEnum.ClaimAdded, eventIdx, block);

  await Claim.create({
    id: getId(target, claimType, scope, jurisdiction, cddId, customClaimTypeId),
    eventIdx,
    targetId: target,
    issuerId: claimIssuer,
    issuanceDate,
    lastUpdateDate,
    expiry: claimExpiry,
    type: claimType as ClaimTypeEnum,
    scope,
    jurisdiction,
    cddId,
    filterExpiry,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    customClaimTypeId,
  }).save();

  if (scope) {
    await handleScopes(
      blockId,
      target,
      scope.type === ClaimScopeTypeEnum.Ticker ? scope.value : undefined,
      scope
    );
  }
};

export const handleClaimRevoked = async (event: SubstrateEvent): Promise<void> => {
  const { params } = extractArgs(event);
  const harvesterArgs = extractHarvesterArgs(event);
  const { claimScope, claimType, issuanceDate, cddId, jurisdiction, customClaimTypeId } =
    extractClaimInfo(harvesterArgs);

  const scope = JSON.parse(claimScope) as Scope;
  const target = getTextValue(params[0]);

  const id = getId(target, claimType, scope, jurisdiction, cddId, customClaimTypeId);

  const claim = await Claim.get(id);

  if (claim) {
    claim.revokeDate = issuanceDate;
    await claim.save();
  }
};

export const handleDidRegistered = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const target = getTextValue(params[0]);
  const ticker = serializeTicker(params[1]);

  await handleScopes(blockId, target, ticker);
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
