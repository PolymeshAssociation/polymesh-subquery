import { Option } from '@polkadot/types';
import { Codec } from '@polkadot/types/types';
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
  blockTime,
  END_OF_TIME,
  emptyDid,
  extractClaimInfo,
  getAssetIdWithTicker,
  getTextValue,
  recordAnomaly,
} from '../../../utils';
import { AssetIdWithTicker } from '../../../utils/assets';
import { CanonicalValue, encodeValue } from '../../args/encode';
import { extractArgs } from '../common';
import { createIdentityIfNotExists } from './mapIdentities';

/**
 * Claim types the v6.0 upgrade's storage migration deleted, every claim of them, without an event.
 * Indexing them would leave claims live that the chain no longer holds, so they are not indexed.
 */
const RETIRED_CLAIM_TYPES = new Set(['InvestorUniqueness', 'InvestorUniquenessV2', 'NoData']);

/** The event's `IdentityClaim` (its second parameter) in the canonical encoding. */
const encodedClaim = (event: SubstrateEvent): CanonicalValue =>
  encodeValue(extractArgs(event).params[1], metadataTypeNames(event)[1]);

/**
 * Claim id: `(target, issuer, claimType, scope)`, the key the chain stores a claim under, so a
 * re-issue replaces the claim as it does on chain: a CDD claim's id or a jurisdiction claim's
 * country is a value of the claim, not part of its key. The issuer is part of the id, so trusted
 * issuers attesting the same target, type and scope are separate rows.
 */
export const getId = (
  target: string,
  issuer: string,
  claimType: string | undefined,
  scope: Scope | undefined,
  customClaimTypeId: string | undefined
): string => {
  const idAttributes = [target, issuer, claimType];

  if (customClaimTypeId) {
    idAttributes.push(customClaimTypeId);
  }

  if (scope) {
    // Not applicable in case of CustomerDueDiligence
    idAttributes.push(scope.type);
    idAttributes.push(scope.assetId ?? scope.value);
  }
  return idAttributes.join('/');
};

/** A claim scope's asset, by id and by ticker, given the scope's raw asset id or ticker */
export type AssetOfScope = (assetIdOrTicker: string) => Promise<AssetIdWithTicker>;

/** A claim scope from its JSON, an asset scope as the chain names it, with its asset id */
export const scopeOf = async (claimScope: string, assetOf: AssetOfScope): Promise<Scope> => {
  const scope = JSON.parse(claimScope);

  if (scope.type === ClaimScopeTypeEnum.Ticker || scope.type === ClaimScopeTypeEnum.Asset) {
    const { assetId, ticker } = await assetOf(scope.value);

    // as the chain scopes it: by the ticker before 7.0, by the asset id from it
    scope.value = scope.type === ClaimScopeTypeEnum.Ticker ? ticker : assetId;
    scope.type = ClaimScopeTypeEnum.Asset;
    scope.assetId = assetId;
  }

  return scope;
};

const processClaimScope = (claimScope: string, block: SubstrateBlock): Promise<Scope> =>
  scopeOf(claimScope, assetIdOrTicker => getAssetIdWithTicker(assetIdOrTicker, block));

/**
 * The claim `identityClaim` describes, an `IdentityClaim` in the canonical encoding, as its row;
 * `undefined` for a claim type the 6.0 upgrade retired. `assetOf` names a scope's asset.
 */
export const claimRow = async (
  target: string,
  identityClaim: CanonicalValue,
  blockEventId: string,
  assetOf: AssetOfScope
): Promise<Claim | undefined> => {
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
  } = extractClaimInfo(identityClaim);
  if (claimType && RETIRED_CLAIM_TYPES.has(claimType)) {
    return undefined;
  }
  // every `IdentityClaim` names its issuer
  const issuer = claimIssuer as string;
  const scope = claimScope ? await scopeOf(claimScope, assetOf) : undefined;

  // the encoding carries moments as decimal strings; the numeric columns hold bigints
  const moment = (value: string | null | undefined): bigint | undefined =>
    value === null || value === undefined ? undefined : BigInt(value);
  const requiredMoment = (value: string | null | undefined, name: string): bigint => {
    const parsed = moment(value);

    if (parsed === undefined) {
      throw new Error(`IdentityClaim has no ${name}`);
    }

    return parsed;
  };
  const expiry = moment(claimExpiry);

  return Claim.create({
    id: getId(target, issuer, claimType, scope, customClaimTypeId),
    targetId: target,
    issuerId: issuer,
    // both are always present on an `IdentityClaim`
    issuanceDate: requiredMoment(issuanceDate, 'issuanceDate'),
    lastUpdateDate: requiredMoment(lastUpdateDate, 'lastUpdateDate'),
    expiry,
    type: claimType as ClaimTypeEnum,
    scope,
    jurisdiction,
    cddId,
    filterExpiry: expiry ?? END_OF_TIME,
    // a re-issue after revocation clears `revokeDate`
    revokeDate: undefined,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
    customClaimTypeId,
  });
};

interface ClaimContext {
  block: SubstrateBlock;
  blockId: string;
  eventIdx: number;
  blockEventId: string;
}

/** Writes the claim `identityClaim` describes, an `IdentityClaim` in the canonical encoding. */
const writeClaim = async (
  target: string,
  identityClaim: CanonicalValue,
  { block, blockId, eventIdx, blockEventId }: ClaimContext
): Promise<void> => {
  const row = await claimRow(target, identityClaim, blockEventId, assetIdOrTicker =>
    getAssetIdWithTicker(assetIdOrTicker, block)
  );
  if (!row) {
    return;
  }

  // The `target` for any claim is not validated, so we make sure it is present in `identities` table
  await createIdentityIfNotExists(
    target,
    blockId,
    EventIdEnum.ClaimAdded,
    eventIdx,
    block,
    blockEventId
  );

  await row.save();
};

export const handleClaimAdded = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, eventIdx, block, blockEventId } = extractArgs(event);
  const target = getTextValue(decodeEvent(event).targetDid);

  await writeClaim(target, encodedClaim(event), { block, blockId, eventIdx, blockEventId });
};

/**
 * An `identity.claims` value as the runtime stores it: a plain `IdentityClaim` in early runtimes,
 * the genesis one (v3.0) among them, and an `Option` in later ones.
 */
export const storedClaim = (value: Codec): Codec | undefined => {
  const optional = value as Partial<Option<Codec>>;

  if (typeof optional.unwrap !== 'function') {
    return value;
  }

  return optional.isNone ? undefined : optional.unwrap();
};

export const handleClaimRevoked = async (event: SubstrateEvent): Promise<void> => {
  const { block, eventIdx, blockEventId } = extractArgs(event);
  const { claimIssuer, claimScope, claimType, customClaimTypeId } = extractClaimInfo(
    encodedClaim(event)
  );

  if (claimType && RETIRED_CLAIM_TYPES.has(claimType)) {
    return;
  }

  let scope: Scope | undefined;
  if (claimScope) {
    scope = await processClaimScope(claimScope, block);
  }

  const target = getTextValue(decodeEvent(event).targetDid);

  // A revocation with a zero issuer has no indexed claim to match and is not attributable, so it is
  // skipped rather than recorded as a missing-entity anomaly.
  if (!claimIssuer || claimIssuer === emptyDid) {
    return;
  }

  const id = getId(target, claimIssuer, claimType, scope, customClaimTypeId);

  const claim = await Claim.get(id);

  if (claim) {
    // `issuanceDate` in the event is the revoked claim's own; the revocation happens at this block
    claim.revokeDate = BigInt(blockTime(block).getTime());
    claim.updatedEventId = blockEventId;
    await claim.save();
  } else {
    /**
     * Ids include the issuer, so a miss means the revoked claim was never indexed, or was indexed
     * under a different id.
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

/** `AssetDidRegistered` writes nothing: a claim's scope is read from its asset directly. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const handleDidRegistered = async (event: SubstrateEvent): Promise<void> => {};
