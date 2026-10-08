import { CanonicalValue } from '../mappings/args/encode';
import { ClaimTypeEnum } from '../types';

type Scope = { type: string | null; value: string | null };

const isObject = (value: CanonicalValue | undefined): value is Record<string, CanonicalValue> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * A scope's `{ type, value }` from its encoded `Scope` enum. Claim ids are built from this, so it
 * keeps the old reading of a non-object: a string's first index, an absent scope's nulls.
 */
const scopeOf = (scope: CanonicalValue | undefined): Scope => {
  if (typeof scope === 'string') {
    return { type: scope.length > 0 ? '0' : null, value: scope[0] || null };
  }
  const type = isObject(scope) ? Object.keys(scope)[0] ?? null : null;
  const value = type && isObject(scope) ? scope[type] : null;
  return { type, value: (value as string | null) || null };
};

/** The scope of an encoded `Claim` variant: the tuple variants carry it at a fixed position. */
export const extractClaimScope = (
  claimType: string | undefined,
  body: CanonicalValue | undefined
): Scope | null => {
  const tuple = Array.isArray(body) ? body : [];

  switch (claimType) {
    case ClaimTypeEnum.CustomerDueDiligence:
      return null;
    case ClaimTypeEnum.InvestorUniqueness:
      return scopeOf(tuple[0]);
    case ClaimTypeEnum.Jurisdiction:
    case ClaimTypeEnum.Custom:
      return scopeOf(tuple[1]);
    default: {
      const scope = scopeOf(body);
      return scope.type ? scope : null;
    }
  }
};

/** What a claim says, from its `IdentityClaim` in the canonical encoding. */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export const extractClaimInfo = (identityClaim: CanonicalValue | undefined) => {
  const value = isObject(identityClaim) ? identityClaim : {};
  const claim = value.claim;
  // a unit variant (`NoData`) encodes as its bare name
  const claimType: string | undefined =
    typeof claim === 'string' ? claim : isObject(claim) ? Object.keys(claim)[0] : undefined;
  const body = isObject(claim) && claimType ? claim[claimType] : undefined;
  const tuple = Array.isArray(body) ? body : [];
  const scope = extractClaimScope(claimType, body);

  return {
    claimType,
    claimScope: scope ? JSON.stringify(scope) : null,
    claimIssuer: value.claimIssuer as string | undefined,
    claimExpiry: value.expiry as string | null | undefined,
    issuanceDate: value.issuanceDate as string | undefined,
    lastUpdateDate: value.lastUpdateDate as string | undefined,
    cddId:
      claimType === ClaimTypeEnum.CustomerDueDiligence ? (body as string | undefined) : undefined,
    jurisdiction:
      claimType === ClaimTypeEnum.Jurisdiction ? (tuple[0] as string | undefined) : undefined,
    customClaimTypeId:
      claimType === ClaimTypeEnum.Custom ? (tuple[0] as string | undefined) : undefined,
  };
};
