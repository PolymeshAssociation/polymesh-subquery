/**
 * Assets and their configuration seeded from the chain: custom types, assets, ticker reservations,
 * documents, metadata, agents and their groups, checkpoints and their schedules, mandatory
 * mediators and pre-approvals.
 */
import { stringToHex } from '@polkadot/util';
import { SEED_EVENT_ID } from '../../../src/mappings/consts';
import { seed } from '../../../src/seed/seeder';
import { SEEDERS } from '../../../src/seed/seeders';
import { accountRows } from '../../../src/seed/seeders/identities';
import { snapshotAtParent } from '../../../src/seed/snapshot';
import { getAssetIdForLegacyTicker } from '../../../src/utils/assets';
import { fakeChain, FakeChain, genesisChain } from './fakeChain';
import { byId } from './goldens';

const ASSET = '0x1234567890abcdef1234567890abcdef';
const NFTS = '0xfedcba0987654321fedcba0987654321';
const UNCOLLECTED = '0x0badc0de0badc0de0badc0de0badc0de';
const OWNER = `0x${'01'.repeat(32)}`;
const HOLDER = `0x${'02'.repeat(32)}`;
const AGENT = `0x${'03'.repeat(32)}`;
const ticker = (text: string) => stringToHex(text.padEnd(12, '\0'));

const ASSET_ENTITIES = [
  'CustomAssetType',
  'Asset',
  'TickerReservation',
  'AssetDocument',
  'GlobalMetadataKey',
  'AssetMetadata',
  'AgentGroup',
  'AssetAgent',
  'AgentGroupMembership',
  'Checkpoint',
  'CheckpointSchedule',
  'AssetMandatoryMediator',
  'AssetPreApproval',
];

const seedAssets = async (chain: FakeChain) => {
  await seed(
    snapshotAtParent(chain.block),
    {
      block: chain.block,
      blockId: '0000001000',
      eventId: SEED_EVENT_ID,
      datetime: new Date(0),
      specVersion: chain.specVersion,
    },
    { seeders: SEEDERS.filter(({ entity }) => ASSET_ENTITIES.includes(entity)), accountRows }
  );
};

describe('from 7.0', () => {
  let chain: FakeChain;
  const rows = (entity: string) => byId(chain.rows(entity));

  beforeAll(async () => {
    chain = fakeChain(8_000_020);
    chain.put('asset.customTypes', [7], 'Bond-like');
    chain.put('asset.assets', [ASSET], {
      totalSupply: 1_000,
      ownerDid: OWNER,
      divisible: true,
      assetType: { Custom: 7 },
    });
    // the chain keeps no supply for a collection; the handlers count the tokens issued
    chain.put('asset.assets', [NFTS], {
      totalSupply: 0,
      ownerDid: OWNER,
      divisible: false,
      // 6.1 took a custom type no one had registered
      assetType: { NonFungible: { Custom: 0 } },
    });
    chain.put('asset.assetNames', [ASSET], 'Acme Bond');
    chain.put('asset.fundingRound', [ASSET], 'Series A');
    chain.put('asset.assetIdentifiers', [ASSET], [{ Isin: 'US0378331005' }]);
    chain.put('asset.frozen', [ASSET], true);
    chain.put('asset.assetIdTicker', [ASSET], ticker('ACME'));
    chain.put('complianceManager.assetCompliances', [ASSET], { paused: true, requirements: [] });
    chain.put('asset.balanceOf', [ASSET, OWNER], 600);
    chain.put('asset.balanceOf', [ASSET, HOLDER], 400);
    chain.put('asset.balanceOf', [ASSET, AGENT], 0);
    chain.put('nft.numberOfNFTs', [NFTS, HOLDER], 2);
    chain.put('nft.collectionAsset', [NFTS], 5);
    // an asset of an NFT type, whose collection no one has created yet
    chain.put('asset.assets', [UNCOLLECTED], {
      totalSupply: 0,
      ownerDid: OWNER,
      divisible: false,
      assetType: { NonFungible: 'Derivative' },
    });

    chain.put('asset.uniqueTickerRegistration', [ticker('ACME')], { owner: OWNER, expiry: null });
    chain.put('asset.tickerAssetId', [ticker('ACME')], ASSET);
    chain.put('asset.uniqueTickerRegistration', [ticker('SPARE')], {
      owner: HOLDER,
      expiry: 1_800_000_000_000,
    });

    chain.put('asset.assetDocuments', [ASSET, 1], {
      uri: 'https://acme.example/prospectus',
      contentHash: { None: null },
      name: 'Prospectus',
      docType: 'pdf',
      filingDate: null,
    });

    chain.put('asset.assetMetadataGlobalKeyToName', [2], 'Rating');
    chain.put('asset.assetMetadataGlobalSpecs', [2], {
      url: null,
      description: 'A rating',
      typeDef: null,
    });
    chain.put('asset.assetMetadataGlobalKeyToName', [3], 'Unused');
    chain.put('asset.assetMetadataLocalKeyToName', [ASSET, 1], 'Coupon');
    chain.put('asset.assetMetadataLocalKeyToName', [ASSET, 4], 'Maturity');
    // local key 2 has no value, though global key 2 does
    chain.put('asset.assetMetadataLocalKeyToName', [ASSET, 2], 'Issuer');
    chain.put('asset.assetMetadataValues', [ASSET, { Local: 1 }], '5%');
    chain.put('asset.assetMetadataValueDetails', [ASSET, { Local: 1 }], {
      expire: null,
      lockStatus: { LockedUntil: 1_900_000_000_000 },
    });
    chain.put('asset.assetMetadataValues', [ASSET, { Global: 2 }], 'AAA');

    chain.put('externalAgents.groupPermissions', [ASSET, 1], { Whole: null });
    chain.put('externalAgents.groupOfAgent', [ASSET, OWNER], { Full: null });
    chain.put('externalAgents.groupOfAgent', [ASSET, AGENT], { Custom: 1 });

    chain.put('checkpoint.timestamps', [ASSET, 1], 1_700_000_000_000);
    chain.put('checkpoint.totalSupply', [ASSET, 1], 900);
    chain.put('checkpoint.timestamps', [ASSET, 2], 1_700_000_600_000);
    chain.put('checkpoint.totalSupply', [ASSET, 2], 1_000);
    chain.put('checkpoint.scheduledCheckpoints', [ASSET, 1], { pending: [1_800_000_000_000] });
    chain.put('checkpoint.schedulePoints', [ASSET, 1], [2]);

    chain.put('asset.mandatoryMediators', [ASSET], [AGENT]);
    chain.put('asset.preApprovedAsset', [HOLDER, ASSET], true);
    // a pre-approval of an asset id no asset has, which the handler records too
    chain.put('asset.preApprovedAsset', [HOLDER, NFTS.replace('fe', 'aa')], true);

    await seedAssets(chain);
  });

  it('seeds the custom asset types', () => {
    expect(rows('CustomAssetType')['7']).toMatchObject({ name: 'Bond-like' });
  });

  it('seeds an asset with what its creation and configuration recorded', () => {
    expect(rows('Asset')[ASSET]).toMatchObject({
      assetId: ASSET,
      ticker: 'ACME',
      name: 'Acme Bond',
      type: 'Bond-like',
      isNftCollection: false,
      fundingRound: 'Series A',
      isDivisible: true,
      isFrozen: true,
      ownerId: OWNER,
      totalSupply: '1000',
      totalTransfers: '0',
      isCompliancePaused: true,
      identifiers: [expect.objectContaining({ value: 'US0378331005' })],
    });
  });

  it('counts the identities holding units or tokens of each asset', () => {
    expect(rows('Asset')[ASSET].holderCount).toBe(2);
    expect(rows('Asset')[NFTS].holderCount).toBe(1);
  });

  it('leaves the type of a collection naming an unregistered custom type unknown, as the handler does', () => {
    expect(rows('Asset')[NFTS]).toMatchObject({ isNftCollection: true, isDivisible: false });
    expect(rows('Asset')[NFTS].type).toBeUndefined();
  });

  it("counts a collection's supply as the tokens held, as the handlers do", () => {
    expect(rows('Asset')[NFTS].totalSupply).toBe('2');
  });

  it('marks a collection once it is created, not for its asset type', () => {
    expect(rows('Asset')[UNCOLLECTED]).toMatchObject({
      isNftCollection: false,
      type: 'Derivative',
    });
  });

  it('leaves an absent name and funding round unset, as the creation handler does', () => {
    expect(rows('Asset')[NFTS].name).toBeUndefined();
    expect(rows('Asset')[NFTS].fundingRound).toBeUndefined();
  });

  it('seeds each ticker reservation, with its asset and expiry', () => {
    expect(rows('TickerReservation').ACME).toMatchObject({
      ticker: 'ACME',
      identityId: OWNER,
      assetId: ASSET,
    });
    expect(rows('TickerReservation').ACME.expiry).toBeUndefined();
    expect(rows('TickerReservation').SPARE).toMatchObject({
      identityId: HOLDER,
      expiry: new Date(1_800_000_000_000).toISOString(),
    });
  });

  it('seeds the documents', () => {
    expect(rows('AssetDocument')[`${ASSET}/1`]).toMatchObject({
      assetId: ASSET,
      documentId: 1,
      name: 'Prospectus',
      link: 'https://acme.example/prospectus',
      type: 'pdf',
    });
  });

  // the spec as the handler keeps it: its JSON, the text as hex
  it('seeds the global metadata keys with their specs', () => {
    expect(rows('GlobalMetadataKey')['2']).toMatchObject({ name: 'Rating' });
    expect(JSON.parse(rows('GlobalMetadataKey')['2'].spec as string)).toMatchObject({
      description: stringToHex('A rating'),
    });
  });

  it('seeds a local key with or without a value, and a global key only where the asset has a value', () => {
    expect(Object.keys(rows('AssetMetadata')).sort()).toEqual(
      [`${ASSET}/Global/2`, `${ASSET}/Local/1`, `${ASSET}/Local/2`, `${ASSET}/Local/4`].sort()
    );
    expect(rows('AssetMetadata')[`${ASSET}/Local/1`]).toMatchObject({
      name: 'Coupon',
      value: '5%',
      isLocked: true,
      lockedUntil: new Date(1_900_000_000_000).toISOString(),
    });
    expect(rows('AssetMetadata')[`${ASSET}/Global/2`]).toMatchObject({
      name: 'Rating',
      value: 'AAA',
    });
    expect(rows('AssetMetadata')[`${ASSET}/Local/4`]).toMatchObject({
      name: 'Maturity',
      isLocked: false,
    });
  });

  it('seeds the agents, the custom groups and their members', () => {
    expect(Object.keys(rows('AssetAgent')).sort()).toEqual(
      [`${ASSET}/${AGENT}`, `${ASSET}/${OWNER}`].sort()
    );
    expect(rows('AgentGroup')[`${ASSET}/1`]).toMatchObject({ assetId: ASSET });
    expect(Object.keys(rows('AgentGroupMembership'))).toEqual([`${ASSET}/1/${AGENT}`]);
  });

  it('seeds the checkpoints, linked to the schedule the chain still holds', () => {
    expect(rows('Checkpoint')[`${ASSET}/1`]).toMatchObject({ checkpointId: 1, totalSupply: '900' });
    expect(rows('Checkpoint')[`${ASSET}/1`].scheduleId).toBeUndefined();
    expect(rows('Checkpoint')[`${ASSET}/2`]).toMatchObject({ scheduleId: `${ASSET}/1` });
    expect(rows('CheckpointSchedule')[`${ASSET}/1`]).toMatchObject({
      scheduleId: 1,
      scheduledCheckpoints: [new Date(1_800_000_000_000).toISOString()],
    });
  });

  it('seeds the mandatory mediators, and the pre-approvals even of an asset id no asset has', () => {
    expect(Object.keys(rows('AssetMandatoryMediator'))).toEqual([`${ASSET}/${AGENT}`]);
    expect(Object.keys(rows('AssetPreApproval'))).toHaveLength(2);
  });
});

describe('text the chain stores empty', () => {
  it('is "", as the chain holds it, not unset', async () => {
    const chain = fakeChain(8_000_020);
    chain.put('asset.assets', [ASSET], {
      totalSupply: 1,
      ownerDid: OWNER,
      divisible: true,
      assetType: 'EquityCommon',
    });
    chain.put('asset.assetNames', [ASSET], '');
    chain.put('asset.fundingRound', [ASSET], '');
    await seedAssets(chain);

    expect(byId(chain.rows('Asset'))[ASSET]).toMatchObject({ name: '', fundingRound: '' });
  });
});

describe('before 7.0', () => {
  it('reads assets, reservations and pre-approvals by ticker, with the asset ids derived from them', async () => {
    const chain = fakeChain(6_002_010);
    chain.put('asset.tokens', [ticker('ACME')], {
      totalSupply: 5,
      ownerDid: OWNER,
      divisible: true,
      assetType: 'EquityCommon',
    });
    chain.put('asset.tickers', [ticker('ACME')], { owner: OWNER, expiry: null });
    chain.put('asset.tickers', [ticker('SPARE')], { owner: HOLDER, expiry: null });
    chain.put('asset.preApprovedTicker', [HOLDER, ticker('ACME')], true);
    chain.put('asset.balanceOf', [ticker('ACME'), OWNER], 5);
    await seedAssets(chain);

    const assetId = await getAssetIdForLegacyTicker(ticker('ACME'));
    expect(byId(chain.rows('Asset'))[assetId]).toMatchObject({
      ticker: 'ACME',
      type: 'EquityCommon',
      totalSupply: '5',
      holderCount: 1,
    });
    expect(byId(chain.rows('TickerReservation')).ACME).toMatchObject({ assetId });
    expect(byId(chain.rows('TickerReservation')).SPARE.assetId).toBeUndefined();
    expect(Object.keys(byId(chain.rows('AssetPreApproval')))).toEqual([`${assetId}/${HOLDER}`]);
  });

  it("seeds an agent group's permissions in the form the index stores them", async () => {
    const chain = fakeChain(6_002_010);
    chain.put('asset.tokens', [ticker('ACME')], {
      totalSupply: 5,
      ownerDid: OWNER,
      divisible: true,
      assetType: 'EquityCommon',
    });
    // a list of pallets before 7.0, which this runtime's metadata decodes with names in hex
    chain.put('externalAgents.groupPermissions', [ticker('ACME'), 1], {
      These: [{ palletName: 'Asset', dispatchableNames: { These: ['redeem', 'issue'] } }],
    });
    await seedAssets(chain);

    const assetId = await getAssetIdForLegacyTicker(ticker('ACME'));
    expect(
      JSON.parse(byId(chain.rows('AgentGroup'))[`${assetId}/1`].permissions as string)
    ).toEqual({
      these: { Asset: { extrinsics: { these: ['issue', 'redeem'] } } },
    });
  });
});

/** Before 6.0 a schedule is a period and a count, held in a list per ticker */
describe('before 6.0', () => {
  it('seeds the schedules the chain still holds, with their period and next moment', async () => {
    const chain = fakeChain(5_001_002);
    chain.put(
      'checkpoint.schedules',
      [ticker('ACME')],
      [
        {
          schedule: { start: 1_640_011_451_564, period: { unit: 'Week', amount: 4 } },
          id: 1,
          at: 1_640_011_451_000,
          remaining: 3,
        },
      ]
    );
    await seedAssets(chain);

    const assetId = await getAssetIdForLegacyTicker(ticker('ACME'));
    const schedule = byId(chain.rows('CheckpointSchedule'))[`${assetId}/1`];
    expect(schedule).toMatchObject({
      assetId,
      scheduleId: 1,
      period: JSON.stringify({ unit: 'Week', amount: 4 }),
      start: new Date(1_640_011_451_564).toISOString(),
      remaining: 3,
      nextCheckpointAt: new Date(1_640_011_451_000).toISOString(),
    });
    expect(schedule.scheduledCheckpoints).toBeUndefined();
  });
});

describe('the genesis', () => {
  it('seeds the 401 ticker registrations the genesis config makes, the fiat ones among them', async () => {
    const chain = genesisChain('testnet');
    await seedAssets(chain);

    const reservations = byId(chain.rows('TickerReservation'));
    expect(Object.keys(reservations)).toHaveLength(401);
    expect(reservations.USD).toMatchObject({
      identityId: '0x73797374656d3a666961745f7469636b6572735f7265736572766174696f6e00',
    });
    expect(reservations.USD.assetId).toBeUndefined();
  });
});
