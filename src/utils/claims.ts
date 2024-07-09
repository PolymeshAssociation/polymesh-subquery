import { ClaimTypeEnum } from '../types';
import { JSONStringifyExceptStringAndNull, extractBigInt, extractString } from './common';

export const extractClaimScope = (
  claimType: string,
  args: any[]
): { type: string; value: string } => {
  switch (claimType) {
    case ClaimTypeEnum.CustomerDueDiligence: {
      return null;
    }
    case ClaimTypeEnum.InvestorUniqueness: {
      const scope = args[1]?.value?.claim?.InvestorUniqueness?.col1;
      const type = Object.keys(scope || {})?.[0] || null;
      const value = scope?.[type] || null;
      return { type, value };
    }
    case ClaimTypeEnum.Jurisdiction: {
      const scope = args[1]?.value?.claim?.Jurisdiction?.col2;
      const type = Object.keys(scope || {})?.[0] || null;
      const value = scope?.[type] || null;
      return { type, value };
    }
    case ClaimTypeEnum.Custom: {
      const scope = args[1]?.value?.claim?.Custom?.col2;
      const type = Object.keys(scope || {})?.[0] || null;
      const value = scope?.[type] || null;
      return { type, value };
    }
    default: {
      const scope = args[1]?.value?.claim?.[claimType];
      const type = Object.keys(scope || {})?.[0] || null;
      if (!type) {
        return null;
      }
      const value = scope?.[type] || null;
      return { type, value };
    }
  }
};

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export const extractClaimInfo = (args: any[]) => {
  const claimValue = args?.[1]?.value || {};
  const claim = claimValue.claim || {};
  const claimType: string | undefined = Object.keys(claim)[0];

  let cddId: any;
  let jurisdiction: any;
  let customClaimTypeId: string;

  if (claimType === ClaimTypeEnum.CustomerDueDiligence) {
    cddId = JSONStringifyExceptStringAndNull(claim.CustomerDueDiligence);
  } else if (claimType === ClaimTypeEnum.Jurisdiction) {
    jurisdiction = JSONStringifyExceptStringAndNull(claim.Jurisdiction?.col1);
  } else if (claimType === ClaimTypeEnum.Custom) {
    customClaimTypeId = extractBigInt(claim.Custom, 'col1').toString();
  }

  return {
    claimType,
    claimScope: JSONStringifyExceptStringAndNull(extractClaimScope(claimType, args)),
    claimIssuer: JSONStringifyExceptStringAndNull(extractString(claimValue, 'claim_issuer')),
    claimExpiry: JSONStringifyExceptStringAndNull(extractString(claimValue, 'expiry')),
    issuanceDate: JSONStringifyExceptStringAndNull(extractString(claimValue, 'issuance_date')),
    lastUpdateDate: JSONStringifyExceptStringAndNull(extractString(claimValue, 'last_update_date')),
    cddId,
    jurisdiction,
    customClaimTypeId,
  };
};
