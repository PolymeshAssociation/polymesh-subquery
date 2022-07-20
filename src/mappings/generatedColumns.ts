// These functions are the equivalent of the ColumnsAndIndeces.sql in the harvester.
// Since we need to index on them, storing them directly through subquery results in
// more readable code than relying on generated columns or materialized views and has
// the same storage overhead.

import { ClaimTypeEnum } from '../types';

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

export const extractClaimInfo = (args: any[]) => {
  const claimType: string | undefined = Object.keys(args?.[1]?.value?.claim || {})[0];

  let cddId: any;
  let jurisdiction: any;
  if (claimType === ClaimTypeEnum.CustomerDueDiligence) {
    cddId = JSONStringifyExceptStringAndNull(args?.[1]?.value?.claim?.CustomerDueDiligence);
  } else if (claimType === ClaimTypeEnum.Jurisdiction) {
    jurisdiction = JSONStringifyExceptStringAndNull(args?.[1]?.value?.claim?.Jurisdiction?.col1);
  }

  return {
    claimType,
    claimScope: JSONStringifyExceptStringAndNull(extractClaimScope(claimType, args)),
    claimIssuer: JSONStringifyExceptStringAndNull(args[1]?.value?.claim_issuer),
    claimExpiry: JSONStringifyExceptStringAndNull(args[1]?.value?.expiry),
    issuanceDate: JSONStringifyExceptStringAndNull(args[1]?.value?.issuance_date),
    lastUpdateDate: JSONStringifyExceptStringAndNull(args[1]?.value?.last_update_date),
    cddId,
    jurisdiction,
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

export const extractOfferingAsset = (args: any[]) => args[3]?.value?.offering_asset;

export const extractTransferTo = (args: any[]) =>
  JSONStringifyExceptStringAndNull(args[3]?.value?.did);
