import '@subql/types/dist/global';
import {
  extractClaimInfo,
  extractCorporateActionTicker,
  extractEventArgs,
  extractOfferingAsset,
  extractTransferTo,
  JSONStringifyExceptStringAndNull,
} from '../../dist/mappings/generatedColumns';

test('JSONStringifyExceptStringAndNull', () => {
  expect(JSONStringifyExceptStringAndNull('hello')).toBe('hello');
  expect(JSONStringifyExceptStringAndNull(undefined)).toBe(undefined);
  expect(JSONStringifyExceptStringAndNull(null)).toBe(null);

  expect(JSONStringifyExceptStringAndNull({ im: 'anobject' })).toBe('{"im":"anobject"}');
  expect(JSONStringifyExceptStringAndNull(5)).toBe('5');
});

test('extractEventArgs', () => {
  expect(
    extractEventArgs([{ value: null }, { value: 'hello' }, { value: { foo: 5 } }])
  ).toStrictEqual({
    eventArg_0: 'null',
    eventArg_1: 'hello',
    eventArg_2: '{"foo":5}',
    eventArg_3: null,
  });
});

test('extractClaimInfo', () => {
  expect(extractClaimInfo([{ value: 'hello' }])).toStrictEqual({
    claimExpiry: undefined,
    claimIssuer: undefined,
    claimScope: '{"type":null,"value":null}',
    claimType: undefined,
    lastUpdateDate: undefined,
    issuanceDate: undefined,
    cddId: undefined,
    jurisdiction: undefined,
  });

  expect(
    extractClaimInfo([
      { value: 'hello' },
      {
        value: {
          claim: { CustomerDueDiligence: '0x000001' },
          claim_issuer: 'me',
          expiry: 400,
          last_update_date: 12345,
          issuance_date: 12345,
        },
      },
    ])
  ).toStrictEqual({
    claimExpiry: '400',
    claimIssuer: 'me',
    claimScope: null,
    claimType: 'CustomerDueDiligence',
    lastUpdateDate: '12345',
    issuanceDate: '12345',
    cddId: '0x000001',
    jurisdiction: undefined,
  });

  expect(
    extractClaimInfo([
      { value: 'hello' },
      {
        value: {
          claim: {
            InvestorUniqueness: { col1: { type: 'Ticker', value: 'STONK' } },
          },
          claim_issuer: 'me',
          expiry: 400,
          last_update_date: 12345,
          issuance_date: 12345,
        },
      },
    ])
  ).toStrictEqual({
    claimExpiry: '400',
    claimIssuer: 'me',
    claimScope: '{"type":"type","value":"Ticker"}',
    claimType: 'InvestorUniqueness',
    lastUpdateDate: '12345',
    issuanceDate: '12345',
    cddId: undefined,
    jurisdiction: undefined,
  });

  expect(
    extractClaimInfo([
      { value: 'hello' },
      {
        value: {
          claim: {
            Jurisdiction: {
              col1: 'IN',
              col2: { type: 'Ticker', value: 'STONK' },
            },
          },
          claim_issuer: 'me',
          expiry: 400,
          last_update_date: 12345,
          issuance_date: 12345,
        },
      },
    ])
  ).toStrictEqual({
    claimExpiry: '400',
    claimIssuer: 'me',
    claimScope: '{"type":"type","value":"Ticker"}',
    claimType: 'Jurisdiction',
    lastUpdateDate: '12345',
    issuanceDate: '12345',
    cddId: undefined,
    jurisdiction: 'IN',
  });

  expect(
    extractClaimInfo([
      { value: 'hello' },
      {
        value: {
          claim: {
            Affiliate: { type: 'Ticker', value: 'STONK' },
          },
          claim_issuer: 'me',
          expiry: 400,
          last_update_date: 12345,
          issuance_date: 12345,
        },
      },
    ])
  ).toStrictEqual({
    claimExpiry: '400',
    claimIssuer: 'me',
    claimScope: '{"type":"type","value":"Ticker"}',
    claimType: 'Affiliate',
    lastUpdateDate: '12345',
    issuanceDate: '12345',
    cddId: undefined,
    jurisdiction: undefined,
  });
});

test('extractCorporateActionTicker', () => {
  expect(extractCorporateActionTicker([{ value: 'foo' }, { value: { ticker: 'STONK' } }])).toBe(
    'STONK'
  );

  expect(
    extractCorporateActionTicker([{ value: 'foo' }, { value: {} }, { value: { ticker: 'STONK' } }])
  ).toBe('STONK');

  expect(extractCorporateActionTicker([])).toBe(null);
});

test('extractOfferingAsset', () => {
  expect(
    extractOfferingAsset([
      { value: 'foo' },
      { value: {} },
      { value: 'something_else' },
      { value: { offering_asset: 'STONK' } },
    ])
  ).toBe('STONK');

  expect(extractOfferingAsset([])).toBe(undefined);
});

test('extractTransferTo', () => {
  expect(
    extractTransferTo([
      { value: 'foo' },
      { value: {} },
      { value: 'something_else' },
      {
        value: {
          did: '0x9a8cf83420fcb598e04bc085303b90a640afa45f75a7548e508170ff291f2779',
          kind: { Default: null },
        },
      },
    ])
  ).toBe('0x9a8cf83420fcb598e04bc085303b90a640afa45f75a7548e508170ff291f2779');

  expect(extractTransferTo([])).toBe(undefined);
});
