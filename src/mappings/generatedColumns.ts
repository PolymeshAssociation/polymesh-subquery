// These functions are the equivalent of the ColumnsAndIndeces.sql in the harvester.
// Since we need to index on them, storing them directly through subquery results in
// more readable code than relying on generated columns or materialized views and has
// the same storage overhead.

import { ClaimTypeEnum } from '../types';
import { snakeToCamelCase } from './util';

/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
export const JSONStringifyExceptStringAndNull = (arg: any) => {
  if (arg !== undefined && arg !== null && typeof arg !== 'string') {
    return JSON.stringify(arg).replace(/(?:^")|(?:"$)/g, '');
  } else {
    return arg;
  }
};

export const extractEventArg = (arg: any, exists: boolean) => {
  if (arg !== undefined && arg !== null && arg?.value != null) {
    return JSONStringifyExceptStringAndNull(arg?.value);
  } else if (exists) {
    return 'null';
  } else {
    return null;
  }
};

export const extractEventArgs = (args: any[]) => {
  const [arg0, arg1, arg2, arg3] = args;
  return {
    eventArg_0: extractEventArg(arg0, args.length > 0),
    eventArg_1: extractEventArg(arg1, args.length > 1),
    eventArg_2: extractEventArg(arg2, args.length > 2),
    eventArg_3: extractEventArg(arg3, args.length > 3),
  };
};

/**
 * Function to get value for a specific key
 * It searches for snake_case and camelCase value for the given key
 */
export const extractValue = <T>(obj: unknown, key: string): T => {
  if (obj) {
    if (Object.keys(obj).includes(key)) {
      return obj[key] as T;
    }
    return obj[snakeToCamelCase(key)] as T;
  }
  return undefined;
};

export const extractString = (obj: unknown, key: string): string => extractValue<string>(obj, key);

export const extractNumber = (obj: unknown, key: string): number => extractValue<number>(obj, key);

export const extractBigInt = (obj: unknown, key: string): bigint => extractValue<bigint>(obj, key);

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

const data = {
  claimIssuer: '0x0100000000000000000000000000000000000000000000000000000000000000',
  issuanceDate: 1697477262002,
  lastUpdateDate: 1697477262002,
  expiry: null,
  claim: {
    Custom: {
      col1: 1,
      col2: { Identity: '0x0100000000000000000000000000000000000000000000000000000000000000' },
    },
  },
};

export const extractClaimInfo = (args: any[]) => {
  const claimValue = args?.[1]?.value || {};
  const claim = claimValue.claim || {};
  const claimType: string | undefined = Object.keys(claim)[0];

  let cddId: any;
  let jurisdiction: any;
  let customClaimTypeId: bigint;

  if (claimType === ClaimTypeEnum.CustomerDueDiligence) {
    cddId = JSONStringifyExceptStringAndNull(claim.CustomerDueDiligence);
  } else if (claimType === ClaimTypeEnum.Jurisdiction) {
    jurisdiction = JSONStringifyExceptStringAndNull(claim.Jurisdiction?.col1);
  } else if (claimType === ClaimTypeEnum.Custom) {
    customClaimTypeId = extractBigInt(claim.Custom, 'col1');
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

export const extractCorporateActionTicker = (args: any[]) => {
  const value1Ticker = args[1]?.value?.ticker;
  if (value1Ticker !== undefined) {
    return value1Ticker;
  }
  const value2Ticker = args[2]?.value?.ticker;
  if (value2Ticker !== undefined) {
    return value2Ticker;
  }
  return null;
};

export const extractOfferingAsset = (args: any[]) =>
  extractString(args[3]?.value, 'offering_asset');

export const extractTransferTo = (args: any[]) =>
  JSONStringifyExceptStringAndNull(args[3]?.value?.did);
