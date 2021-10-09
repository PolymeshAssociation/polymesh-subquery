import "@subql/types/dist/global";
import {
  extractClaimInfo,
  extractCorporateActionTicker,
  extractEventArgs,
  extractOfferingAsset,
  extractTransferTo,
  JSONStringifyExceptStringAndNull,
} from "../src/mappings/generatedColumns";

test("JSONStringifyExceptStringAndNull", () => {
  expect(JSONStringifyExceptStringAndNull("hello")).toBe("hello");
  expect(JSONStringifyExceptStringAndNull(undefined)).toBe(undefined);
  expect(JSONStringifyExceptStringAndNull(null)).toBe(null);

  expect(JSONStringifyExceptStringAndNull({ im: "anobject" })).toBe(
    '{"im":"anobject"}'
  );
  expect(JSONStringifyExceptStringAndNull(5)).toBe("5");
});

test("extractEventArgs", () => {
  expect(
    extractEventArgs([
      { value: null },
      { value: "hello" },
      { value: { foo: 5 } },
    ])
  ).toStrictEqual({
    eventArg_0: "null",
    eventArg_1: "hello",
    eventArg_2: '{"foo":5}',
    eventArg_3: null,
  });
});

test("extractClaimInfo", () => {
  expect(extractClaimInfo([{ value: "hello" }])).toStrictEqual({
    claimExpiry: undefined,
    claimIssuer: undefined,
    claimScope: '{"type":null,"value":null}',
    claimType: undefined,
  });

  expect(
    extractClaimInfo([
      { value: "hello" },
      {
        value: {
          claim: { CustomerDueDiligence: {} },
          claim_issuer: "me",
          expiry: 400,
        },
      },
    ])
  ).toStrictEqual({
    claimExpiry: "400",
    claimIssuer: "me",
    claimScope: null,
    claimType: "CustomerDueDiligence",
  });

  expect(
    extractClaimInfo([
      { value: "hello" },
      {
        value: {
          claim: {
            InvestorUniqueness: { col1: { type: "Ticker", value: "STONK" } },
          },
          claim_issuer: "me",
          expiry: 400,
        },
      },
    ])
  ).toStrictEqual({
    claimExpiry: "400",
    claimIssuer: "me",
    claimScope: '{"type":"type","value":"Ticker"}',
    claimType: "InvestorUniqueness",
  });

  expect(
    extractClaimInfo([
      { value: "hello" },
      {
        value: {
          claim: {
            Jurisdiction: { col2: { type: "Ticker", value: "STONK" } },
          },
          claim_issuer: "me",
          expiry: 400,
        },
      },
    ])
  ).toStrictEqual({
    claimExpiry: "400",
    claimIssuer: "me",
    claimScope: '{"type":"type","value":"Ticker"}',
    claimType: "Jurisdiction",
  });

  expect(
    extractClaimInfo([
      { value: "hello" },
      {
        value: {
          claim: {
            Affiliate: { type: "Ticker", value: "STONK" },
          },
          claim_issuer: "me",
          expiry: 400,
        },
      },
    ])
  ).toStrictEqual({
    claimExpiry: "400",
    claimIssuer: "me",
    claimScope: '{"type":"type","value":"Ticker"}',
    claimType: "Affiliate",
  });
});

test("extractCorporateActionTicker", () => {
  expect(
    extractCorporateActionTicker([
      { value: "foo" },
      { value: { ticker: "STONK" } },
    ])
  ).toBe("STONK");

  expect(
    extractCorporateActionTicker([
      { value: "foo" },
      { value: {} },
      { value: { ticker: "STONK" } },
    ])
  ).toBe("STONK");

  expect(extractCorporateActionTicker([])).toBe(null);
});

test("extractOfferingAsset", () => {
  expect(
    extractOfferingAsset([
      { value: "foo" },
      { value: {} },
      { value: "something_else" },
      { value: { offering_asset: "STONK" } },
    ])
  ).toBe("STONK");

  expect(extractOfferingAsset([])).toBe(undefined);
});

test("extractTransferTo", () => {
  expect(
    extractTransferTo([
      { value: "foo" },
      { value: {} },
      { value: "something_else" },
      {
        value: {
          did: "0x9a8cf83420fcb598e04bc085303b90a640afa45f75a7548e508170ff291f2779",
          kind: { Default: null },
        },
      },
    ])
  ).toBe("0x9a8cf83420fcb598e04bc085303b90a640afa45f75a7548e508170ff291f2779");

  expect(extractTransferTo([])).toBe(undefined);
});
