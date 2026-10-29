/**
 * Corporate actions, their assets' defaults, distributions, ballots and their votes, and
 * offerings, built as their handlers build them.
 */
import { stringToHex } from '@polkadot/util';
import { SEED_EVENT_ID } from '../../../src/mappings/consts';
import { seed } from '../../../src/seed/seeder';
import { SEEDERS } from '../../../src/seed/seeders';
import { accountRows } from '../../../src/seed/seeders/identities';
import { snapshotAtParent } from '../../../src/seed/snapshot';
import { fakeChain, FakeChain } from './fakeChain';
import { byId } from './goldens';

const ASSET = '0x1234567890abcdef1234567890abcdef';
const CURRENCY = '0xfedcba0987654321fedcba0987654321';
const ISSUER = `0x${'01'.repeat(32)}`;
const VOTER = `0x${'02'.repeat(32)}`;
const CA = { assetId: ASSET, localId: 3 };
const ENTITIES = [
  'CorporateAction',
  'CorporateActionDefaultConfig',
  'Distribution',
  'CorporateBallot',
  'CorporateBallotVote',
  'Sto',
];

describe('from 7.0', () => {
  let chain: FakeChain;
  const rows = (entity: string) => byId(chain.rows(entity));

  beforeAll(async () => {
    chain = fakeChain(8_001_020);
    chain.put('corporateAction.corporateActions', [ASSET, 3], {
      kind: 'PredictableBenefit',
      declDate: 1_700_000_000_000,
      recordDate: null,
      targets: { identities: [VOTER], treatment: 'Exclude' },
      defaultWithholdingTax: 100_000,
      withholdingTax: [[VOTER, 50_000]],
    });
    chain.put('corporateAction.details', [CA], 'Dividend Q3');
    chain.put('corporateAction.caDocLink', [CA], [1, 2]);
    chain.put('corporateAction.defaultTargetIdentities', [ASSET], {
      identities: [VOTER],
      treatment: 'Include',
    });
    chain.put('corporateAction.defaultWithholdingTax', [ASSET], 200_000);
    chain.put('corporateAction.didWithholdingTax', [ASSET], [[VOTER, 10_000]]);
    chain.put('capitalDistribution.distributions', [CA], {
      from: { did: ISSUER, kind: { User: 1 } },
      currency: CURRENCY,
      perShare: 5,
      amount: 1_000,
      remaining: 600,
      reclaimed: false,
      paymentAt: 1_700_000_100_000,
      expiresAt: null,
    });
    chain.put('corporateBallot.metas', [CA], {
      title: 'Approve',
      motions: [{ title: 'Motion 1', infoLink: 'https://x', choices: ['Yes', 'No'] }],
    });
    chain.put('corporateBallot.timeRanges', [CA], {
      start: 1_700_000_000_000,
      end: 1_800_000_000_000,
    });
    chain.put('corporateBallot.rcv', [CA], true);
    chain.put(
      'corporateBallot.votes',
      [CA, VOTER],
      [
        { power: 10, fallback: null },
        { power: 0, fallback: 1 },
      ]
    );
    chain.put('asset.assetIdTicker', [CURRENCY], stringToHex('USDX'.padEnd(12, '\0')));
    chain.put('sto.fundraisers', [ASSET, 1], {
      creator: ISSUER,
      offeringPortfolio: { did: ISSUER, kind: { Default: null } },
      offeringAsset: ASSET,
      raisingPortfolio: { did: ISSUER, kind: { User: 1 } },
      raisingAsset: CURRENCY,
      tiers: [{ total: 100, price: 2, remaining: 40 }],
      venueId: 4,
      start: 1_700_000_000_000,
      end: null,
      status: 'Live',
      minimumInvestment: 10,
    });
    chain.put('sto.fundraiserNames', [ASSET, 1], 'Round A');
    chain.put('sto.fundraiserOffchainAsset', [ASSET, 1], stringToHex('OFFCHN'.padEnd(12, '\0')));

    await seed(
      snapshotAtParent(chain.block),
      {
        block: chain.block,
        blockId: '0000001000',
        eventId: SEED_EVENT_ID,
        datetime: new Date(0),
        specVersion: 8_001_020,
      },
      { seeders: SEEDERS.filter(({ entity }) => ENTITIES.includes(entity)), accountRows }
    );
  });

  it('seeds each live corporate action with its details and linked documents', () => {
    expect(rows('CorporateAction')[`${ASSET}/3`]).toMatchObject({
      localId: 3,
      kind: 'PredictableBenefit',
      details: 'Dividend Q3',
      documents: ['1', '2'],
      targetIdentities: [VOTER],
      targetTreatment: 'Exclude',
      isRemoved: false,
    });
  });

  it("seeds an asset's default targets and taxes", () => {
    expect(rows('CorporateActionDefaultConfig')[ASSET]).toMatchObject({
      targetIdentities: [VOTER],
      targetTreatment: 'Include',
      defaultWithholdingTax: '200000',
      didWithholdingTax: [{ did: VOTER, tax: '10000' }],
    });
  });

  it('seeds each live distribution with what remains of it, its tax counted from the start', () => {
    expect(rows('Distribution')[`${ASSET}/3`]).toMatchObject({
      identityId: ISSUER,
      corporateActionId: `${ASSET}/3`,
      portfolioId: `${ISSUER}/1`,
      currencyId: CURRENCY,
      amount: '1000',
      remaining: '600',
      taxes: '0',
    });
  });

  it('seeds each ballot and its votes', () => {
    expect(rows('CorporateBallot')[`${ASSET}/3`]).toMatchObject({
      corporateActionId: `${ASSET}/3`,
      rcv: true,
      isRemoved: false,
      startDate: new Date(1_700_000_000_000).toISOString(),
    });
    expect(rows('CorporateBallotVote')[`${ASSET}/3/${VOTER}`]).toMatchObject({
      ballotId: `${ASSET}/3`,
      voterId: VOTER,
      votes: [{ power: '10' }, { power: '0', fallback: 1 }],
    });
  });

  it('seeds each offering, its raising asset named by ticker, with its off-chain funding', () => {
    expect(rows('Sto')[`${ASSET}/1`]).toMatchObject({
      stoId: 1,
      name: 'Round A',
      status: 'Live',
      raisingAssetId: CURRENCY,
      raisingTicker: 'USDX',
      venueId: '0000000004',
      offChainFundingEnabled: true,
      offChainFundingToken: 'OFFCHN',
    });
  });
});
