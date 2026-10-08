import { TypeRegistry } from '@polkadot/types';
import { typesBundle } from '@polymeshassociation/polymesh-types';
import { encodeValue } from '../../src/mappings/args/encode';
import { extractClaimInfo } from '../../src/utils/claims';

const specTypes = (typesBundle as any).spec.polymesh_mainnet.types as {
  minmax: [number, number | null];
  types: Record<string, unknown>;
}[];

/** A registry with the chain types of the runtime starting at `fromSpec`. */
const registryFor = (fromSpec: number) => {
  const registry = new TypeRegistry();
  registry.setKnownTypes({ typesBundle: typesBundle as never });
  registry.register(specTypes.find(({ minmax }) => minmax[0] === fromSpec)?.types as never);
  return registry;
};

const v8 = registryFor(8_000_000);
const v5 = registryFor(5_004_000);

const DID = `0x${'01'.padStart(64, '0')}`;
const ASSET = `0x${'ab'.repeat(16)}`;
const CDD = `0x${'cd'.repeat(32)}`;
const TICKER = '0x535430434b00000000000000';

const v8Claim = (claim: unknown, expiry: number | null = 400) =>
  v8.createType('IdentityClaim', {
    claimIssuer: DID,
    issuanceDate: 12345,
    lastUpdateDate: 12345,
    expiry,
    claim,
  });

const v5Claim = (claim: unknown) =>
  v5.createType('IdentityClaim', {
    claim_issuer: DID,
    issuance_date: 1,
    last_update_date: 2,
    expiry: 5,
    claim,
  });

const v8Dates = {
  claimIssuer: DID,
  claimExpiry: '400',
  issuanceDate: '12345',
  lastUpdateDate: '12345',
};
const v5Dates = { claimIssuer: DID, claimExpiry: '5', issuanceDate: '1', lastUpdateDate: '2' };
const scope = (type: string | null, value: string | null) => JSON.stringify({ type, value });

// The expected column is what the harvester path wrote for the same claim; never edit it.
const cases: [string, ReturnType<typeof v8Claim>, Record<string, unknown>][] = [
  [
    'CustomerDueDiligence',
    v8Claim({ CustomerDueDiligence: CDD }),
    { claimType: 'CustomerDueDiligence', claimScope: null, cddId: CDD, ...v8Dates },
  ],
  [
    'Accredited by asset',
    v8Claim({ Accredited: { Asset: ASSET } }),
    { claimType: 'Accredited', claimScope: scope('Asset', ASSET), ...v8Dates },
  ],
  [
    'Affiliate by identity, no expiry',
    v8Claim({ Affiliate: { Identity: DID } }, null),
    { claimType: 'Affiliate', claimScope: scope('Identity', DID), ...v8Dates, claimExpiry: null },
  ],
  [
    'Jurisdiction',
    v8Claim({ Jurisdiction: ['IN', { Asset: ASSET }] }),
    {
      claimType: 'Jurisdiction',
      claimScope: scope('Asset', ASSET),
      jurisdiction: 'IN',
      ...v8Dates,
    },
  ],
  [
    'Custom',
    v8Claim({ Custom: [7, { Identity: DID }] }),
    { claimType: 'Custom', claimScope: scope('Identity', DID), customClaimTypeId: '7', ...v8Dates },
  ],
  [
    'Custom without a scope',
    v8Claim({ Custom: [8, null] }),
    { claimType: 'Custom', claimScope: scope(null, null), customClaimTypeId: '8', ...v8Dates },
  ],
  [
    'Custom with a u32::MAX id',
    v8Claim({ Custom: [4294967295, { Asset: ASSET }] }),
    {
      claimType: 'Custom',
      claimScope: scope('Asset', ASSET),
      customClaimTypeId: '4294967295',
      ...v8Dates,
    },
  ],
  [
    'Exempted',
    v8Claim({ Exempted: { Asset: ASSET } }),
    { claimType: 'Exempted', claimScope: scope('Asset', ASSET), ...v8Dates },
  ],
  [
    'Blocked',
    v8Claim({ Blocked: { Identity: DID } }),
    { claimType: 'Blocked', claimScope: scope('Identity', DID), ...v8Dates },
  ],
  [
    'Accredited by a custom text scope',
    v8Claim({ Accredited: { Custom: '0x68656c6c6f' } }),
    { claimType: 'Accredited', claimScope: scope('Custom', 'hello'), ...v8Dates },
  ],
  [
    'Accredited by a custom binary scope',
    v8Claim({ Accredited: { Custom: '0xff00' } }),
    { claimType: 'Accredited', claimScope: scope('Custom', '0xff00'), ...v8Dates },
  ],
  [
    'v5 Accredited by ticker',
    v5Claim({ Accredited: { Ticker: TICKER } }),
    { claimType: 'Accredited', claimScope: scope('Ticker', 'ST0CK'), ...v5Dates },
  ],
  [
    'v5 Jurisdiction by identity',
    v5Claim({ Jurisdiction: ['GB', { Identity: DID }] }),
    {
      claimType: 'Jurisdiction',
      claimScope: scope('Identity', DID),
      jurisdiction: 'GB',
      ...v5Dates,
    },
  ],
  [
    'v5 InvestorUniqueness',
    v5Claim({ InvestorUniqueness: [{ Ticker: TICKER }, `0x${'ee'.repeat(32)}`, CDD] }),
    { claimType: 'InvestorUniqueness', claimScope: scope('Ticker', 'ST0CK'), ...v5Dates },
  ],
  [
    // the harvester path read the CDD id string's first index as a scope; its ids keep that
    'v5 InvestorUniquenessV2',
    v5Claim({ InvestorUniquenessV2: CDD }),
    { claimType: 'InvestorUniquenessV2', claimScope: scope('0', '0'), ...v5Dates },
  ],
  ['v5 NoData', v5Claim({ NoData: null }), { claimType: 'NoData', claimScope: null, ...v5Dates }],
];

describe('claims read from the canonical encoding match the harvester path', () => {
  it.each(cases)('%s', (_, identityClaim, expected) => {
    expect(extractClaimInfo(encodeValue(identityClaim, 'IdentityClaim'))).toEqual(expected);
  });
});
