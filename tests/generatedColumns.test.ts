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
    event_arg_0: "null",
    event_arg_1: "hello",
    event_arg_2: '{"foo":5}',
    event_arg_3: null,
  });
});

test("extractClaimInfo", () => {
  expect(extractClaimInfo([{ value: "hello" }])).toStrictEqual({
    claim_expiry: undefined,
    claim_issuer: undefined,
    claim_scope: '{"type":null,"value":null}',
    claim_type: undefined,
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
    claim_expiry: "400",
    claim_issuer: "me",
    claim_scope: null,
    claim_type: "CustomerDueDiligence",
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
    claim_expiry: "400",
    claim_issuer: "me",
    claim_scope: '{"type":"type","value":"Ticker"}',
    claim_type: "InvestorUniqueness",
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
    claim_expiry: "400",
    claim_issuer: "me",
    claim_scope: '{"type":"type","value":"Ticker"}',
    claim_type: "Jurisdiction",
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
    claim_expiry: "400",
    claim_issuer: "me",
    claim_scope: '{"type":"type","value":"Ticker"}',
    claim_type: "Affiliate",
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

  expect(extractOfferingAsset([])).toBe(undefined);
});
