/**
 * Claims, custom claim types and pending authorizations, and the compliance an asset keeps: its
 * statistics, transfer conditions and their exemptions, requirements and trusted issuers.
 */
import { stringToHex } from '@polkadot/util';
import { SEED_EVENT_ID } from '../../../src/mappings/consts';
import { seed } from '../../../src/seed/seeder';
import { SEEDERS } from '../../../src/seed/seeders';
import { accountRows } from '../../../src/seed/seeders/identities';
import { snapshotAtParent } from '../../../src/seed/snapshot';
import { fakeChain, FakeChain, genesisChain } from './fakeChain';
import { byId, golden } from './goldens';

const ASSET = '0x1234567890abcdef1234567890abcdef';
const TARGET = `0x${'01'.repeat(32)}`;
const ISSUER = `0x${'02'.repeat(32)}`;
const OTHER = `0x${'03'.repeat(32)}`;
const KEY = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

const ENTITIES = [
  'CustomClaimType',
  'Claim',
  'Authorization',
  'StatType',
  'TransferCompliance',
  'TransferComplianceExemption',
  'Compliance',
  'TrustedClaimIssuer',
];

const seedClaims = (chain: FakeChain, blockId = '0000001000') =>
  seed(
    snapshotAtParent(chain.block),
    {
      block: chain.block,
      blockId,
      eventId: SEED_EVENT_ID,
      datetime: new Date(0),
      specVersion: chain.specVersion,
    },
    { seeders: SEEDERS.filter(({ entity }) => ENTITIES.includes(entity)), accountRows }
  );

const claim = (body: unknown, expiry: number | null = null) => ({
  claimIssuer: ISSUER,
  issuanceDate: 100,
  lastUpdateDate: 200,
  expiry,
  claim: body,
});

describe.each(['testnet', 'mainnet'] as const)('the %s genesis', chainName => {
  it('seeds the claims the genesis handler wrote', async () => {
    const chain = genesisChain(chainName);
    await seedClaims(chain, '0000000000');

    expect(byId(chain.rows('Claim'))).toEqual(byId(golden(chainName).Claim));
  });
});

describe('from 7.0', () => {
  let chain: FakeChain;
  const rows = (entity: string) => byId(chain.rows(entity));

  beforeAll(async () => {
    chain = fakeChain(8_000_020);
    chain.put('identity.customClaims', [4], 'KYC-plus');
    chain.put('asset.assetIdTicker', [ASSET], stringToHex('ACME'.padEnd(12, '\0')));
    chain.put(
      'identity.claims',
      [
        { target: TARGET, claimType: 'Accredited' },
        { issuer: ISSUER, scope: { Asset: ASSET } },
      ],
      claim({ Accredited: { Asset: ASSET } }, 1_900_000_000_000)
    );
    chain.put(
      'identity.claims',
      [
        { target: TARGET, claimType: 'Jurisdiction' },
        { issuer: ISSUER, scope: { Identity: OTHER } },
      ],
      claim({ Jurisdiction: ['Ie', { Identity: OTHER }] })
    );
    chain.put(
      'identity.claims',
      [
        { target: TARGET, claimType: { Custom: 4 } },
        { issuer: ISSUER, scope: null },
      ],
      claim({ Custom: [4, null] })
    );
    chain.put('identity.authorizations', [{ Identity: TARGET }, 7], {
      authorizationData: {
        JoinIdentity: {
          asset: { Whole: null },
          extrinsic: { Whole: null },
          portfolio: { Whole: null },
        },
      },
      authorizedBy: ISSUER,
      expiry: 1_900_000_000_000,
      authId: 7,
      count: 50,
    });
    chain.put('identity.authorizations', [{ Account: KEY }, 8], {
      // 8.0 renamed the authorization, which the index still calls AddRelayerPayingKey
      authorizationData: { OldAddRelayerPayingKey: [KEY, KEY, 1_000] },
      authorizedBy: ISSUER,
      expiry: null,
      authId: 8,
      count: 50,
    });

    chain.put(
      'statistics.activeAssetStats',
      [ASSET],
      [
        { operationType: 'Count', claimIssuer: null },
        { operationType: 'Balance', claimIssuer: null },
      ]
    );
    chain.put('statistics.assetTransferCompliances', [ASSET], {
      paused: false,
      requirements: [
        { MaxInvestorCount: 100 },
        { MaxInvestorCount: 110 },
        { MaxInvestorOwnership: 500_000 },
      ],
    });
    chain.put(
      'statistics.transferConditionExemptEntities',
      [{ assetId: ASSET, op: 'Balance', claimType: null }, OTHER],
      true
    );
    chain.put('complianceManager.assetCompliances', [ASSET], {
      paused: false,
      requirements: [{ senderConditions: [], receiverConditions: [], id: 3 }],
    });
    chain.put(
      'complianceManager.trustedClaimIssuer',
      [ASSET],
      [{ issuer: ISSUER, trustedFor: { Any: null } }]
    );

    await seedClaims(chain);
  });

  it('seeds the custom claim types', () => {
    expect(rows('CustomClaimType')['4']).toMatchObject({ name: 'KYC-plus' });
  });

  it('seeds each claim under the id the chain keys it by, its asset scope naming the asset id', () => {
    const claims = chain.rows('Claim');
    expect(claims).toHaveLength(3);
    expect(claims.find(({ type }) => type === 'Accredited')).toMatchObject({
      id: `${TARGET}/${ISSUER}/Accredited/Asset/${ASSET}`,
      targetId: TARGET,
      issuerId: ISSUER,
      scope: { type: 'Asset', value: ASSET, assetId: ASSET },
      expiry: BigInt(1_900_000_000_000),
      filterExpiry: BigInt(1_900_000_000_000),
    });
    expect(claims.find(({ type }) => type === 'Jurisdiction')).toMatchObject({
      jurisdiction: 'IE',
    });
    expect(claims.find(({ type }) => type === 'Custom')).toMatchObject({ customClaimTypeId: '4' });
  });

  it('seeds each pending authorization, to an identity or to a key', () => {
    expect(rows('Authorization')['0000000007']).toMatchObject({
      fromId: ISSUER,
      toId: TARGET,
      type: 'JoinIdentity',
      status: 'Pending',
      expiry: new Date(1_900_000_000_000).toISOString(),
    });
    expect(rows('Authorization')['0000000008']).toMatchObject({
      toAccountId: KEY,
      type: 'AddRelayerPayingKey',
    });
  });

  it('seeds the active statistics', () => {
    expect(Object.keys(rows('StatType')).sort()).toEqual([`${ASSET}/Balance`, `${ASSET}/Count`]);
  });

  it('keeps each transfer condition, though two share a statistic', () => {
    expect(
      chain
        .rows('TransferCompliance')
        .map(({ type, value }) => `${type}:${value}`)
        .sort()
    ).toEqual(['MaxInvestorCount:100', 'MaxInvestorCount:110', 'MaxInvestorOwnership:500000']);
  });

  it('seeds the exemptions, requirements and trusted issuers', () => {
    expect(Object.keys(rows('TransferComplianceExemption'))).toEqual([
      `${ASSET}/Balance/null/${OTHER}`,
    ]);
    expect(Object.keys(rows('Compliance'))).toEqual([`${ASSET}/3`]);
    expect(Object.keys(rows('TrustedClaimIssuer'))).toEqual([`${ASSET}/${ISSUER}`]);
  });
});

describe('before 7.0', () => {
  it("seeds a key authorization's extrinsic permissions in the form the index stores them", async () => {
    const chain = fakeChain(6_002_010);
    chain.put('identity.authorizations', [{ Identity: TARGET }, 7], {
      authorizationData: {
        JoinIdentity: {
          asset: { Whole: null },
          // a list of pallets before 7.0, which this runtime's metadata decodes with names in hex
          extrinsic: { These: [{ palletName: 'Asset', dispatchableNames: { Whole: null } }] },
          portfolio: { Whole: null },
        },
      },
      authorizedBy: ISSUER,
      expiry: null,
      authId: 7,
      count: 50,
    });
    await seed(
      snapshotAtParent(chain.block),
      {
        block: chain.block,
        blockId: '0000001000',
        eventId: SEED_EVENT_ID,
        datetime: new Date('2026-01-01T00:00:00Z'),
        specVersion: 6_002_010,
      },
      { seeders: SEEDERS.filter(({ entity }) => entity === 'Authorization'), accountRows }
    );

    expect(JSON.parse(byId(chain.rows('Authorization'))['0000000007'].data as string)).toEqual({
      asset: { whole: null },
      extrinsic: { these: { Asset: { extrinsics: { whole: null } } } },
      portfolio: { whole: null },
    });
  });
});
