import '@subql/types-core/dist/global';
import '@subql/types/dist/global';
import { JSONStringifyExceptStringAndNull } from '../../src/utils/common';
import { extractClaimInfo } from './../../src/utils/claims';

test('JSONStringifyExceptStringAndNull', () => {
  expect(JSONStringifyExceptStringAndNull('hello')).toBe('hello');
  expect(JSONStringifyExceptStringAndNull(undefined)).toBe(undefined);
  expect(JSONStringifyExceptStringAndNull(null)).toBe(null);

  expect(JSONStringifyExceptStringAndNull({ im: 'anobject' })).toBe('{"im":"anobject"}');
  expect(JSONStringifyExceptStringAndNull(5)).toBe('5');
});

test('extractClaimInfo', () => {
  expect(extractClaimInfo(undefined)).toStrictEqual({
    claimExpiry: undefined,
    claimIssuer: undefined,
    claimScope: null,
    claimType: undefined,
    lastUpdateDate: undefined,
    issuanceDate: undefined,
    cddId: undefined,
    jurisdiction: undefined,
    customClaimTypeId: undefined,
  });

  expect(
    extractClaimInfo({
      claim: { CustomerDueDiligence: '0x000001' },
      claimIssuer: 'me',
      expiry: '400',
      lastUpdateDate: '12345',
      issuanceDate: '12345',
    })
  ).toStrictEqual({
    claimExpiry: '400',
    claimIssuer: 'me',
    claimScope: null,
    claimType: 'CustomerDueDiligence',
    lastUpdateDate: '12345',
    issuanceDate: '12345',
    cddId: '0x000001',
    jurisdiction: undefined,
    customClaimTypeId: undefined,
  });

  expect(
    extractClaimInfo({
      claim: {
        Jurisdiction: ['IN', { type: 'Ticker', value: 'STONK' }],
      },
      claimIssuer: 'me',
      expiry: '400',
      lastUpdateDate: '12345',
      issuanceDate: '12345',
    })
  ).toStrictEqual({
    claimExpiry: '400',
    claimIssuer: 'me',
    claimScope: '{"type":"type","value":"Ticker"}',
    claimType: 'Jurisdiction',
    lastUpdateDate: '12345',
    issuanceDate: '12345',
    cddId: undefined,
    jurisdiction: 'IN',
    customClaimTypeId: undefined,
  });

  expect(
    extractClaimInfo({
      claim: {
        Affiliate: { type: 'Ticker', value: 'STONK' },
      },
      claimIssuer: 'me',
      expiry: '400',
      lastUpdateDate: '12345',
      issuanceDate: '0',
    })
  ).toStrictEqual({
    claimExpiry: '400',
    claimIssuer: 'me',
    claimScope: '{"type":"type","value":"Ticker"}',
    claimType: 'Affiliate',
    lastUpdateDate: '12345',
    issuanceDate: '0',
    cddId: undefined,
    jurisdiction: undefined,
    customClaimTypeId: undefined,
  });

  expect(
    extractClaimInfo({
      claim: {
        Affiliate: { type: 'Ticker', value: 'STONK' },
      },
      claimIssuer: 'me',
      expiry: '400',
      lastUpdateDate: '12345',
      issuanceDate: '0',
    })
  ).toStrictEqual({
    claimExpiry: '400',
    claimIssuer: 'me',
    claimScope: '{"type":"type","value":"Ticker"}',
    claimType: 'Affiliate',
    lastUpdateDate: '12345',
    issuanceDate: '0',
    cddId: undefined,
    jurisdiction: undefined,
    customClaimTypeId: undefined,
  });

  expect(
    extractClaimInfo({
      claim: {
        Custom: [
          '1',
          {
            Identity: '0x0100000000000000000000000000000000000000000000000000000000000000',
          },
        ],
      },
      claimIssuer: 'me',
      expiry: '400',
      lastUpdateDate: '12345',
      issuanceDate: '0',
    })
  ).toStrictEqual({
    claimExpiry: '400',
    claimIssuer: 'me',
    claimScope:
      '{"type":"Identity","value":"0x0100000000000000000000000000000000000000000000000000000000000000"}',
    claimType: 'Custom',
    lastUpdateDate: '12345',
    issuanceDate: '0',
    cddId: undefined,
    jurisdiction: undefined,
    customClaimTypeId: '1',
  });
});
