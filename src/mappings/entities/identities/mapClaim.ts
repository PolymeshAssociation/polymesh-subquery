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
  scanDoubleMap,
} from '../../../utils';
import { CanonicalValue, encodeValue } from '../../args/encode';
import { extractArgs } from '../common';
import { createIdentityIfNotExists } from './mapIdentities';

/** The event's `IdentityClaim` (its second parameter) in the canonical encoding. */
const encodedClaim = (event: SubstrateEvent): CanonicalValue =>
  encodeValue(extractArgs(event).params[1], metadataTypeNames(event)[1]);

/**
 * Claim id: `(target, issuer, claimType, …)` — current-state semantics, one row per
 * issuer per claim. `issuer` is deliberately part of the id: without it, two trusted
 * issuers attesting the same target/type/scope collide on the same row, and the SDK's
 * `issuerId: { in: $trustedClaimIssuers }` filter silently loses whichever claim was
 * written first. Block/eventIdx are deliberately NOT part of the id — the
 * SDK's claims query is a current-state question ("does T hold a valid claim from A?"),
 * and an append-only id would force every consumer to add a "latest per group" filter
 * they do not have today.
 */
export const getId = (
  target: string,
  issuer: string,
  claimType: string | undefined,
  scope: Scope | undefined,
  jurisdiction: string | undefined,
  cddId: string | undefined,
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
  // every `IdentityClaim` names its issuer
  const issuer = claimIssuer as string;

  let scope: Scope | undefined;
  if (claimScope) {
    scope = await processClaimScope(claimScope, block);
  }

  // the encoding's decimal strings, which the store writes into the numeric columns as they are
  const moment = (value: string | null | undefined) => value as unknown as bigint;
  const filterExpiry = moment(claimExpiry) || END_OF_TIME;

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
    id: getId(target, issuer, claimType, scope, jurisdiction, cddId, customClaimTypeId),
    targetId: target,
    issuerId: issuer,
    issuanceDate: moment(issuanceDate),
    lastUpdateDate: moment(lastUpdateDate),
    expiry: moment(claimExpiry),
    type: claimType as ClaimTypeEnum,
    scope,
    jurisdiction,
    cddId,
    filterExpiry,
    // A fresh `Claim.create` fully replaces any row at this id, so a re-issue after
    // revocation implicitly clears `revokeDate` — stated here rather than left implicit.
    revokeDate: undefined,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
    customClaimTypeId,
  }).save();
};

export const handleClaimAdded = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, eventIdx, block, blockEventId } = extractArgs(event);
  const target = getTextValue(decodeEvent(event).did);

  await writeClaim(target, encodedClaim(event), { block, blockId, eventIdx, blockEventId });
};

/**
 * An `identity.claims` value as the runtime stores it: a plain `IdentityClaim` in early runtimes,
 * the genesis one (v3.0) among them, and an `Option` in later ones.
 */
const storedClaim = (value: Codec): Codec | undefined => {
  const optional = value as Partial<Option<Codec>>;

  if (typeof optional.unwrap !== 'function') {
    return value;
  }

  return optional.isNone ? undefined : optional.unwrap();
};

/**
 * The claims in the chain's genesis config, which no `ClaimAdded` announces: CDD claims for genesis
 * and system identities, issued by the governance committee and the CDD system identity. Read from
 * `identity.claims` at the genesis block and written as if added there, so a later `ClaimRevoked`
 * finds them.
 */
export const seedGenesisClaims = async (
  block: SubstrateBlock,
  blockId: string,
  blockEventId: string
): Promise<void> => {
  const entries = await scanDoubleMap(api.query.identity.claims);

  await Promise.all(
    entries.map(([key, value], eventIdx) => {
      const stored = storedClaim(value);

      if (!stored) {
        return undefined;
      }

      const target = (key.args[0] as unknown as { target: Codec }).target.toString();
      return writeClaim(target, encodeValue(stored, 'IdentityClaim'), {
        block,
        blockId,
        eventIdx,
        blockEventId,
      });
    })
  );
};

export const handleClaimRevoked = async (event: SubstrateEvent): Promise<void> => {
  const { block, eventIdx, blockEventId } = extractArgs(event);
  const { claimIssuer, claimScope, claimType, cddId, jurisdiction, customClaimTypeId } =
    extractClaimInfo(encodedClaim(event));

  let scope: Scope | undefined;
  if (claimScope) {
    scope = await processClaimScope(claimScope, block);
  }

  const target = getTextValue(decodeEvent(event).did);

  // Some early-chain revocations emit a stripped `ClaimRevoked` with a zero issuer and a `NoData`
  // claim — there is no indexed claim these could match, and it is not a real attributable
  // revocation, so it is skipped rather than recorded as a missing-entity anomaly.
  if (!claimIssuer || claimIssuer === emptyDid) {
    return;
  }

  const id = getId(target, claimIssuer, claimType, scope, jurisdiction, cddId, customClaimTypeId);

  const claim = await Claim.get(id);

  if (claim) {
    // `issuanceDate` in the event is the revoked claim's own; the revocation happens at this block
    claim.revokeDate = BigInt(blockTime(block).getTime());
    claim.updatedEventId = blockEventId;
    await claim.save();
  } else {
    /**
     * With issuer-scoped ids the lookup above is exact, so a miss here means the revoked claim
     * was never indexed, or was indexed under a different id, rather than merely being one of
     * several rows sharing an id as it silently did before the issuer was part of the id
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
