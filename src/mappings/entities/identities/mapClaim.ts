import { GenericEvent } from '@polkadot/types/generic';
import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import {
  Claim,
  ClaimScope,
  ClaimScopeTypeEnum,
  ClaimTypeEnum,
  EventIdEnum,
  Scope,
} from '../../../types';
import {
  END_OF_TIME,
  extractClaimInfo,
  getAssetId,
  getAssetIdWithTicker,
  getTextValue,
  logFoundType,
} from '../../../utils';
import { serializeLikeHarvester } from '../../serializeLikeHarvester';
import { extractArgs } from '../common';
import { createIdentityIfNotExists } from './mapIdentities';

const extractHarvesterArgs = (event: SubstrateEvent) => {
  const genericEvent = event.event as unknown as GenericEvent;
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
    idAttributes.push(scope.assetId ?? scope.value);
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

const processClaimScope = async (claimScope: any, block: SubstrateBlock): Promise<Scope> => {
  const scope = JSON.parse(claimScope);

  if (scope.type === ClaimScopeTypeEnum.Ticker || scope.type === ClaimScopeTypeEnum.Asset) {
    scope.type = ClaimScopeTypeEnum.Asset;
    const { assetId, ticker } = await getAssetIdWithTicker(scope.value, block);

    if (ticker) {
      scope.value = ticker;
    }

    scope.assetId = assetId;
  }

  return scope;
};

export const handleClaimAdded = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, eventIdx, block, params, blockEventId } = extractArgs(event);
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

  let scope: Scope;
  if (claimScope) {
    scope = await processClaimScope(claimScope, block);
  }

  const filterExpiry = claimExpiry || END_OF_TIME;

  // The `target` for any claim is not validated, so we make sure it is present in `identities` table
  await createIdentityIfNotExists(
    target,
    blockId,
    EventIdEnum.ClaimAdded,
    eventIdx,
    block,
    blockEventId
  );

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
    createdEventId: blockEventId,
  }).save();

  if (scope) {
    await handleScopes(
      blockId,
      target,
      scope.type === ClaimScopeTypeEnum.Asset || scope.type === ClaimScopeTypeEnum.Ticker
        ? scope.value
        : undefined,
      scope
    );
  }
};

export const handleClaimRevoked = async (event: SubstrateEvent): Promise<void> => {
  const { params, block } = extractArgs(event);
  const harvesterArgs = extractHarvesterArgs(event);
  const { claimScope, claimType, issuanceDate, cddId, jurisdiction, customClaimTypeId } =
    extractClaimInfo(harvesterArgs);

  let scope: Scope;
  if (claimScope) {
    scope = await processClaimScope(claimScope, block);
  }

  const target = getTextValue(params[0]);

  const id = getId(target, claimType, scope, jurisdiction, cddId, customClaimTypeId);

  const claim = await Claim.get(id);

  if (claim) {
    claim.revokeDate = issuanceDate;
    await claim.save();
  }
};

export const handleDidRegistered = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block } = extractArgs(event);

  const target = getTextValue(params[0]);
  const assetId = await getAssetId(params[1], block);

  await handleScopes(blockId, target, assetId);
};

const handleScopes = async (
  blockId: string,
  target: string,
  assetId?: string,
  scope?: Scope
): Promise<void> => {
  const id = `${target}/${scope?.value || assetId}`;
  await ClaimScope.create({
    id,
    target,
    assetId,
    scope,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};
