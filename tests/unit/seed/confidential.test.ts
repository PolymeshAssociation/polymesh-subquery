/**
 * Confidential assets (testnet from 8.0): keys and the keys shared keys went to, accounts, assets
 * and their encryption keys and mediators, registrations, settlements in flight with their legs and affirmations, and curve-tree leaves.
 */
import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { SEED_EVENT_ID } from '../../../src/mappings/consts';
import { handleConfidentialEncryptionKeyDistributed } from '../../../src/mappings/entities/confidentialAssets/mapConfidentialAccount';
import { handleConfidentialAssetCreated } from '../../../src/mappings/entities/confidentialAssets/mapConfidentialAsset';
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
  'ConfidentialAssetEncryptionKey',
  'ConfidentialAssetMediator',
  'ConfidentialSharedKeyRecipient',
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
    expect(Object.keys(rows('ConfidentialAssetEncryptionKey'))).toEqual([`3/${KEY}`]);
    expect(rows('ConfidentialAssetMediator')[`3/${ACCOUNT}`]).toMatchObject({
      assetId: '3',
      accountId: ACCOUNT,
    });
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

const OTHER_KEY = `0x${'0d'.repeat(32)}`;
const KEY_ENTITIES = [
  'ConfidentialAssetEncryptionKey',
  'ConfidentialAssetMediator',
  'ConfidentialSharedKeyRecipient',
];

/** Seeds only the asset keys, mediators and shared key recipients from `chain` */
const seedAssetKeys = async (chain: FakeChain) => {
  await seed(
    snapshotAtParent(chain.block),
    {
      block: chain.block,
      blockId: '0000001000',
      eventId: SEED_EVENT_ID,
      datetime: new Date(0),
      specVersion: chain.specVersion,
    },
    {
      seeders: SEEDERS.filter(({ entity }) => KEY_ENTITIES.includes(entity)),
      accountRows,
    }
  );
  return Object.fromEntries(KEY_ENTITIES.map(entity => [entity, byId(chain.rows(entity))]));
};

describe('asset keys before 8.2', () => {
  it('seeds every key the asset holds and its mediators, whatever key each was paired with', async () => {
    const chain = fakeChain(8_001_020);
    chain.put('confidentialAssets.keys', [3], {
      encKeys: [KEY, OTHER_KEY],
      mediators: { [ACCOUNT]: 1 },
    });

    const seeded = await seedAssetKeys(chain);

    expect(Object.keys(seeded.ConfidentialAssetEncryptionKey).sort()).toEqual(
      [`3/${KEY}`, `3/${OTHER_KEY}`].sort()
    );
    expect(Object.keys(seeded.ConfidentialAssetMediator)).toEqual([`3/${ACCOUNT}`]);
    expect(seeded.ConfidentialSharedKeyRecipient).toEqual({});
  });
});

describe('asset keys from 8.2', () => {
  it("seeds an asset's mediators from the set of accounts the keys hold", async () => {
    const chain = fakeChain(8_002_000);
    chain.put('confidentialAssets.keys', [3], { encKeys: [KEY], mediators: [ACCOUNT] });

    const seeded = await seedAssetKeys(chain);

    expect(seeded.ConfidentialAssetEncryptionKey[`3/${KEY}`]).toMatchObject({
      assetId: '3',
      encryptionKeyId: KEY,
    });
    expect(seeded.ConfidentialAssetMediator[`3/${ACCOUNT}`]).toMatchObject({
      assetId: '3',
      accountId: ACCOUNT,
    });
  });

  it('seeds the keys each shared key was distributed to', async () => {
    const chain = fakeChain(8_002_000);
    chain.put('confidentialAssets.sharedKeyRecipients', [OTHER_KEY], [KEY]);

    const seeded = await seedAssetKeys(chain);

    expect(seeded.ConfidentialSharedKeyRecipient).toEqual({
      [`${OTHER_KEY}/${KEY}`]: expect.objectContaining({
        sharedKeyId: OTHER_KEY,
        recipientId: KEY,
        createdEventId: SEED_EVENT_ID,
      }),
    });
  });

  it('reads an asset the 8.2 migration skipped from its old encoding', async () => {
    const chain = fakeChain(8_002_000);
    // one key, and the mediator with the index of its key, as 8.1 stored them
    chain.putRaw('confidentialAssets.keys', [3], `0x04${KEY.slice(2)}04${ACCOUNT.slice(2)}00`);

    const seeded = await seedAssetKeys(chain);

    expect(Object.keys(seeded.ConfidentialAssetEncryptionKey)).toEqual([`3/${KEY}`]);
    expect(Object.keys(seeded.ConfidentialAssetMediator)).toEqual([`3/${ACCOUNT}`]);
  });

  it('fails on stored keys that decode with neither encoding', async () => {
    const chain = fakeChain(8_002_000);
    // the old encoding of one key and one mediator, with a byte left over
    chain.putRaw('confidentialAssets.keys', [3], `0x04${KEY.slice(2)}04${ACCOUNT.slice(2)}00ff`);

    await expect(seedAssetKeys(chain)).rejects.toThrow(
      "asset 3's keys decode with neither the 8.2 nor the old encoding"
    );
  });
});

const codec = (value: unknown): Codec =>
  ({
    toString: () => (typeof value === 'string' ? value : JSON.stringify(value)),
    toJSON: () => value,
    toHex: () => String(value),
  } as unknown as Codec);

const event = (method: string, params: unknown[]): SubstrateEvent =>
  ({
    idx: 0,
    block: {
      block: { header: { number: { toString: () => '1000' } } },
      timestamp: new Date(0),
      specVersion: 8_002_000,
    },
    event: { method, section: 'confidentialAssets', data: params.map(codec) },
  } as unknown as SubstrateEvent);

/** What an index built from events holds, without the events each row cites */
const rowIds = (chain: FakeChain) =>
  Object.fromEntries(
    KEY_ENTITIES.map(entity => [
      entity,
      chain
        .rows(entity)
        .map(({ id }) => id)
        .sort(),
    ])
  );

/**
 * The same asset set up four ways: a mediator `ACCOUNT` whose own key is `KEY`, an auditor key
 * `AUDITOR`, and a key `SHARED` distributed to `KEY` and `RECIPIENT`. The index the handlers build
 * from the events must match the one seeded from the storage they leave.
 */
describe('a seeded index matches the one built from events', () => {
  const AUDITOR = `0x${'21'.repeat(32)}`;
  const SHARED = `0x${'22'.repeat(32)}`;
  const RECIPIENT = `0x${'23'.repeat(32)}`;

  it.each([
    ['own key, also named as an auditor', KEY, [KEY, AUDITOR], [KEY, AUDITOR], false],
    ['own key, mediator only', KEY, [AUDITOR], [KEY, AUDITOR], false],
    ['shared key', SHARED, [AUDITOR], [SHARED, AUDITOR], true],
    ['shared key, own key also an auditor', SHARED, [KEY, AUDITOR], [KEY, SHARED, AUDITOR], true],
  ])('%s', async (_case, mediatorKey, auditors, encKeys, shared) => {
    const built = fakeChain(8_002_000);
    if (shared) {
      await handleConfidentialEncryptionKeyDistributed(
        event('EncryptionKeyDistributed', [
          DID,
          SHARED,
          { publicKey: SHARED, recipientPks: [KEY, RECIPIENT], inner: '0x' },
        ])
      );
    }
    await handleConfidentialAssetCreated(
      event('AssetCreated', [DID, '3', { [ACCOUNT]: mediatorKey }, auditors, '0x', '0x', '6', '0x'])
    );

    const seeded = fakeChain(8_002_000);
    seeded.put('confidentialAssets.keys', [3], { encKeys, mediators: [ACCOUNT] });
    if (shared) {
      seeded.put('confidentialAssets.sharedKeyRecipients', [SHARED], [KEY, RECIPIENT]);
    }
    await seedAssetKeys(seeded);

    expect(rowIds(seeded)).toEqual(rowIds(built));
    expect(rowIds(seeded).ConfidentialAssetEncryptionKey).toHaveLength(encKeys.length);
  });
});
