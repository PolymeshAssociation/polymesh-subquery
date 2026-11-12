/**
 * Confidential assets (testnet from 8.0): keys, accounts, assets and their auditor and mediator
 * keys, registrations, settlements in flight with their legs and affirmations, and curve-tree leaves.
 */
import { SEED_EVENT_ID } from '../../../src/mappings/consts';
import { seed } from '../../../src/seed/seeder';
import { SEEDERS } from '../../../src/seed/seeders';
import { accountRows } from '../../../src/seed/seeders/identities';
import { snapshotAtParent } from '../../../src/seed/snapshot';
import { fakeChain, FakeChain } from './fakeChain';
import { byId } from './goldens';

const DID = `0x${'01'.repeat(32)}`;
const KEY = `0x${'0a'.repeat(32)}`;
const ACCOUNT = `0x${'0b'.repeat(32)}`;
const SETTLEMENT = `0x${'0c'.repeat(32)}`;
const REJECTED = `0x${'0e'.repeat(32)}`;
const EXECUTED = `0x${'0f'.repeat(32)}`;
const ENTITIES = [
  'ConfidentialEncryptionKey',
  'ConfidentialAccount',
  'ConfidentialAsset',
  'ConfidentialAssetKey',
  'ConfidentialAccountAsset',
  'ConfidentialSettlement',
  'ConfidentialLeg',
  'ConfidentialLegAffirmation',
  'ConfidentialCurveTreeLeaf',
];

describe('from 8.0', () => {
  let chain: FakeChain;
  const rows = (entity: string) => byId(chain.rows(entity));

  beforeAll(async () => {
    chain = fakeChain(8_001_020);
    chain.put('confidentialAssets.encryptionKeyDid', [KEY], DID);
    chain.put('confidentialAssets.accountDid', [ACCOUNT], DID);
    chain.put('confidentialAssets.accountEncryptionKey', [ACCOUNT], KEY);
    chain.put('confidentialAssets.details', [3], { totalSupply: 1_000, ownerDid: DID, data: '0x' });
    chain.put('confidentialAssets.names', [3], 'Secret');
    chain.put('confidentialAssets.symbols', [3], 'SCRT');
    chain.put('confidentialAssets.decimals', [3], 6);
    chain.put('confidentialAssets.keys', [3], { encKeys: [KEY], mediators: { [ACCOUNT]: 0 } });
    chain.put('confidentialAssets.accountAssetRegistrations', [ACCOUNT, 3], true);
    chain.put('confidentialAssets.settlementLegCount', [SETTLEMENT], 1);
    chain.put('confidentialAssets.settlementState', [SETTLEMENT], 'Pending');
    chain.put('confidentialAssets.settlementMemo', [SETTLEMENT], `0x${'61'.repeat(32)}`);
    chain.put('confidentialAssets.settlementLegs', [SETTLEMENT, 0], '0x1234');
    chain.put('confidentialAssets.legAffirmationStatus', [SETTLEMENT, 0, 'Sender'], 'Affirmed');
    chain.put('confidentialAssets.legAffirmationStatus', [SETTLEMENT, 0, 'Receiver'], 'Pending');
    chain.put('confidentialAssets.accountLeaves', [0], `0x${'0d'.repeat(32)}`);
    // a party that reverted its affirmation of a rejected settlement reads Finalized, as one that
    // claimed an executed settlement's leg does
    chain.put('confidentialAssets.settlementLegCount', [REJECTED], 1);
    chain.put('confidentialAssets.settlementState', [REJECTED], 'Rejected');
    chain.put('confidentialAssets.legAffirmationStatus', [REJECTED, 0, 'Sender'], 'Finalized');
    chain.put('confidentialAssets.legAffirmationStatus', [REJECTED, 0, 'Receiver'], 'Rejected');
    chain.put('confidentialAssets.settlementLegCount', [EXECUTED], 1);
    chain.put('confidentialAssets.settlementState', [EXECUTED], 'Executed');
    chain.put('confidentialAssets.legAffirmationStatus', [EXECUTED, 0, 'Receiver'], 'Finalized');
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

  it('seeds the keys and accounts, with who registered them', () => {
    expect(rows('ConfidentialEncryptionKey')[KEY]).toMatchObject({ creatorId: DID });
    expect(rows('ConfidentialAccount')[ACCOUNT]).toMatchObject({
      encryptionKeyId: KEY,
      creatorId: DID,
    });
  });

  it('seeds each asset with its name, symbol, decimals and supply, and its keys', () => {
    expect(rows('ConfidentialAsset')['3']).toMatchObject({
      name: 'Secret',
      symbol: 'SCRT',
      decimals: 6,
      creatorId: DID,
      totalSupply: '1000',
    });
    expect(
      chain
        .rows('ConfidentialAssetKey')
        .map(({ role }) => role)
        .sort()
    ).toEqual(['Auditor', 'Mediator']);
    expect(Object.keys(rows('ConfidentialAccountAsset'))).toEqual([`3/${ACCOUNT}`]);
  });

  it('seeds a settlement in flight with its legs, and the affirmations made so far', () => {
    expect(rows('ConfidentialSettlement')[SETTLEMENT]).toMatchObject({
      legCount: 1,
      status: 'Pending',
      memo: 'a'.repeat(32),
    });
    expect(rows('ConfidentialSettlement')[SETTLEMENT].assetRootBlock).toBeUndefined();
    expect(Object.keys(rows('ConfidentialLeg'))).toEqual([`${SETTLEMENT}/0`]);
    expect(
      Object.keys(rows('ConfidentialLegAffirmation')).filter(id => id.startsWith(SETTLEMENT))
    ).toEqual([`${SETTLEMENT}/0/Sender`]);
  });

  it('seeds a sender or receiver finalized in a rejected settlement as reverted', () => {
    expect(rows('ConfidentialLegAffirmation')[`${REJECTED}/0/Sender`].status).toBe('Reverted');
    expect(rows('ConfidentialLegAffirmation')[`${REJECTED}/0/Receiver`].status).toBe('Rejected');
    expect(rows('ConfidentialLegAffirmation')[`${EXECUTED}/0/Receiver`].status).toBe('Finalized');
  });

  it('seeds the curve-tree leaves', () => {
    expect(rows('ConfidentialCurveTreeLeaf')['Account/0']).toMatchObject({
      tree: 'Account',
      leafIndex: '0',
    });
  });
});
