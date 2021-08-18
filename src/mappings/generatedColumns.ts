// These functions are the equivalent of the ColumnsAndIndeces.sql in the harvester.
// Since we need to index on them, storing them directly through subquery results in
// more readable code than relying on generated columns or materialized views and has
// the same storage overhead.

/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
export const JSONStringifyExceptStringAndNull = (arg: any) => {
  if (arg !== undefined && arg !== null && typeof arg !== "string") {
    return JSON.stringify(arg);
  } else {
    return arg;
  }
};

export const extractEventArg = (arg: any, exists: boolean) => {
  if (arg !== undefined && arg !== null && arg?.value != null) {
    return JSONStringifyExceptStringAndNull(arg?.value);
  } else if (exists) {
    return "null";
  } else {
    return null;
  }
};

export const extractEventArgs = (args: any[]) => {
  const [arg0, arg1, arg2, arg3] = args;
  return {
    event_arg_0: extractEventArg(arg0, args.length > 0),
    event_arg_1: extractEventArg(arg1, args.length > 1),
    event_arg_2: extractEventArg(arg2, args.length > 2),
    event_arg_3: extractEventArg(arg3, args.length > 3),
  };
};

export const extractClaimScope = (
  claim_type: string,
  args: any[]
): { type: string; value: string } => {
  switch (claim_type) {
    case "CustomerDueDiligence": {
      return null;
    }
    case "InvestorUniqueness": {
      const scope = args[1]?.value?.claim?.InvestorUniqueness?.col1;
      const type = Object.keys(scope || {})?.[0] || null;
      const value = scope?.[type] || null;
      return { type, value };
    }
    case "Jurisdiction": {
      const scope = args[1]?.value?.claim?.Jurisdiction?.col2;
      const type = Object.keys(scope || {})?.[0] || null;
      const value = scope?.[type] || null;
      return { type, value };
    }
    default: {
      const scope = args[1]?.value?.claim?.[claim_type];
      const type = Object.keys(scope || {})?.[0] || null;
      const value = scope?.[type] || null;
      return { type, value };
    }
  }
};

export const extractClaimInfo = (args: any[]) => {
  const claim_type: string | undefined = Object.keys(
    args?.[1]?.value?.claim || {}
  )[0];

  return {
    claim_type,
    claim_scope: JSONStringifyExceptStringAndNull(
      extractClaimScope(claim_type, args)
    ),
    claim_issuer: JSONStringifyExceptStringAndNull(
      args[1]?.value?.claim_issuer
    ),
    claim_expiry: JSONStringifyExceptStringAndNull(args[1]?.value?.expiry),
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
  args[3]?.value?.offering_asset;
