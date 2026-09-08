import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { decodeEvent, metadataTypeNames } from '../../../decode';
import {
  AnomalyKind,
  Claim,
  ClaimScopeTypeEnum,
  ClaimTypeEnum,
  EventIdEnum,
  ModuleIdEnum,
  Scope,
} from '../../../types';
import {
  END_OF_TIME,
  extractClaimInfo,
  getAssetIdWithTicker,
  getTextValue,
  logFoundType,
  recordAnomaly,
} from '../../../utils';
import { serializeLikeHarvester } from '../../serializeLikeHarvester';
import { extractArgs } from '../common';
import { createIdentityIfNotExists } from './mapIdentities';

const extractHarvesterArgs = (event: SubstrateEvent) => {
  const args = event.event.data;
  const types = metadataTypeNames(event);

  return args.map((arg, i) => ({
    value: serializeLikeHarvester(arg, types[i], logFoundType),
  }));
};

/**
 * Claim id: `(target, issuer, claimType, …)` — current-state semantics, one row per
 * issuer per claim. `issuer` is deliberately part of the id: without it, two trusted
 * issuers attesting the same target/type/scope collide on the same row, and the SDK's
 * `issuerId: { in: $trustedClaimIssuers }` filter silently loses whichever claim was
 * written first (defect A12). Block/eventIdx are deliberately NOT part of the id — the
 * SDK's claims query is a current-state question ("does T hold a valid claim from A?"),
 * and an append-only id would force every consumer to add a "latest per group" filter
 * they do not have today.
 */
export const getId = (
  target: string,
  issuer: string,
  claimType: string,
  scope: Scope,
  jurisdiction: string,
  cddId: string,
  customClaimTypeId: string | undefined
): string => {
  const idAttributes = [target, issuer, claimType];

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
  const { blockId, eventIdx, block, blockEventId } = extractArgs(event);
  const harvesterArgs = extractHarvesterArgs(event);
  const target = getTextValue(decodeEvent(event).did);

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
    id: getId(target, claimIssuer, claimType, scope, jurisdiction, cddId, customClaimTypeId),
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
    // A fresh `Claim.create` fully replaces any row at this id, so a re-issue after
    // revocation implicitly clears `revokeDate` — stated here rather than left implicit.
    revokeDate: undefined,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    customClaimTypeId,
    createdEventId: blockEventId,
  }).save();
};

export const handleClaimRevoked = async (event: SubstrateEvent): Promise<void> => {
  const { block, eventIdx } = extractArgs(event);
  const harvesterArgs = extractHarvesterArgs(event);
  const {
    claimIssuer,
    claimScope,
    claimType,
    issuanceDate,
    cddId,
    jurisdiction,
    customClaimTypeId,
  } = extractClaimInfo(harvesterArgs);

  let scope: Scope;
  if (claimScope) {
    scope = await processClaimScope(claimScope, block);
  }

  const target = getTextValue(decodeEvent(event).did);

  const id = getId(target, claimIssuer, claimType, scope, jurisdiction, cddId, customClaimTypeId);

  const claim = await Claim.get(id);

  if (claim) {
    claim.revokeDate = issuanceDate;
    await claim.save();
  } else {
    /**
     * With issuer-scoped ids the lookup above is exact, so a miss here means the revoked claim
     * was never indexed, or was indexed under a different id, rather than merely being one of
     * several rows sharing an id as it silently was before A12 was fixed
     */
    await recordAnomaly({
      kind: AnomalyKind.MissingReferencedEntity,
      detail: `ClaimRevoked found no Claim at id "${id}" (target ${target}, issuer ${claimIssuer}, type ${claimType})`,
      block,
      eventIdx,
      moduleId: ModuleIdEnum.identity,
      eventId: EventIdEnum.ClaimRevoked,
    });
  }
};

/**
 * `AssetDidRegistered` previously only fed a `ClaimScope` row (the legacy ticker DID mapped
 * to its asset). `ClaimScope` is removed — `Claim.scope` is already populated straight from
 * `Asset` via `processClaimScope`/`getAssetIdWithTicker`, so nothing depended on that table.
 * There is no other Claim-side state derived from this event, so this is now a no-op. The
 * subscription in project.ts is left in place unchanged, per the redesign's `project.ts: No
 * change` note for this phase.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const handleDidRegistered = async (event: SubstrateEvent): Promise<void> => {};
