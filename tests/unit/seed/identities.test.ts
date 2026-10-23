/**
 * Identities, their accounts and keys, and their portfolios, seeded from the chain: on each chain's
 * 3.x genesis as today's genesis handler writes them, and on the runtimes since.
 */
import { encodeAddress } from '@polkadot/util-crypto';
import { SEED_EVENT_ID, systematicIssuers } from '../../../src/mappings/consts';
import { seed, SeedContext } from '../../../src/seed/seeder';
import { SEEDERS } from '../../../src/seed/seeders';
import { accountRows } from '../../../src/seed/seeders/identities';
import { snapshotAtParent } from '../../../src/seed/snapshot';
import { fakeChain, FakeChain, genesisChain } from './fakeChain';
import { byId, golden } from './goldens';

const contextOf = (chain: FakeChain, blockId: string): SeedContext => ({
  block: chain.block,
  blockId,
  eventId: SEED_EVENT_ID,
  datetime: new Date(0),
  specVersion: chain.specVersion,
});

const seedOf = async (chain: FakeChain, entities: string[], blockId = '0000001000') => {
  await seed(snapshotAtParent(chain.block), contextOf(chain, blockId), {
    seeders: SEEDERS.filter(({ entity }) => entities.includes(entity)),
    accountRows,
  });
};

/** The zero account: the primary key of a 3.x identity record read for a DID that has none */
const zeroAccount = (): string =>
  encodeAddress(new Uint8Array(32), (globalThis as any).api.registry.chainSS58);

/**
 * Today's genesis handler, less the 20 identities it invents: it reads 33 reserved DIDs with
 * `didRecords.multi`, and on 3.x a DID with no record reads as a default one, the zero account its
 * primary key. Their rows, and the zero account's, are left out; the seed writes none of them.
 */
const genuine = (chainName: 'testnet' | 'mainnet', entity: string) => {
  const rows = golden(chainName);
  const phantom = new Set(
    rows.Identity.filter(({ primaryAccountId }) => primaryAccountId === zeroAccount()).map(
      ({ id }) => id
    )
  );
  return rows[entity].filter(
    row =>
      ![row.id, row.identityId, (row.id as string).split('/')[0]].some(id =>
        phantom.has(id as string)
      ) && row.id !== zeroAccount()
  );
};

const SYSTEMATIC = new Set(Object.values(systematicIssuers).map(({ did }) => did));

/**
 * Rows less the systematic issuers' keys: the genesis handler wrote a key only for an issuer it
 * funded, and the seed writes every one the chain records
 */
const lessSystematicKeys = (rows: Record<string, unknown>[]) =>
  rows.filter(({ identityId }) => !SYSTEMATIC.has(identityId as string));

describe.each(['testnet', 'mainnet'] as const)('the %s genesis', chainName => {
  let chain: FakeChain;

  beforeAll(async () => {
    chain = genesisChain(chainName);
    await seedOf(chain, ['Identity', 'Account', 'IdentityKey', 'Portfolio'], '0000000000');
  });

  it.each(['Identity', 'Portfolio'])('seeds the %s rows the genesis handler wrote', entity => {
    expect(byId(chain.rows(entity))).toEqual(byId(genuine(chainName, entity)));
  });

  it("seeds the identities' accounts the genesis handler wrote", () => {
    // an unlinked account comes with the multisig or balance that names it
    expect(
      byId(
        lessSystematicKeys(chain.rows('Account')).filter(
          ({ keyRole }) => keyRole !== 'MultiSigSigner'
        )
      )
    ).toEqual(
      byId(
        lessSystematicKeys(genuine(chainName, 'Account')).filter(
          ({ keyRole }) => keyRole !== 'Unlinked'
        )
      )
    );
  });

  it("makes each genesis multisig's signers multisig signers, as `multiSig.keyToMultiSig` records them", () => {
    // the genesis handler wrote them unlinked, and the index's first multisig events relinked them
    const signers = chain.rows('Account').filter(({ keyRole }) => keyRole === 'MultiSigSigner');
    expect(signers).toHaveLength(5);
    expect(signers.every(({ identityId }) => !identityId)).toBe(true);
  });

  it('opens the key intervals the genesis handler opened, with their permissions', () => {
    // the seed's intervals open at the seed, not at a `DidCreated`, and keep a secondary key's
    // permissions, which the handler left out
    expect(
      byId(lessSystematicKeys(chain.rows('IdentityKey')), ['addedReason', 'permissions'])
    ).toEqual(byId(lessSystematicKeys(genuine(chainName, 'IdentityKey')), ['addedReason']));
  });

  it("records each systematic issuer's primary key, which the genesis handler mostly skipped", () => {
    const keys = chain
      .rows('IdentityKey')
      .filter(({ identityId }) => SYSTEMATIC.has(identityId as string));
    expect(keys.map(({ role }) => role)).toEqual(Array(8).fill('PrimaryKey'));
  });
});

describe('from 7.0', () => {
  const DID = `0x${'01'.repeat(32)}`;
  const PRIMARY = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
  const SECONDARY = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
  const SIGNER = '5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y';
  const CUSTODIAN = `0x${'02'.repeat(32)}`;
  const ASSET_DID = `0x${'03'.repeat(32)}`;
  let chain: FakeChain;

  beforeAll(async () => {
    chain = fakeChain(8_000_020);
    chain.put('identity.didRecords', [DID], { primaryKey: PRIMARY });
    chain.put('identity.didRecords', [CUSTODIAN], {
      primaryKey: '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy',
    });
    // a record with no key, as before 7.0 each asset had one: no DidCreated announced it
    chain.put('identity.didRecords', [ASSET_DID], { primaryKey: null });
    chain.put('identity.isDidFrozen', [DID], true);
    chain.put('identity.keyRecords', [PRIMARY], { PrimaryKey: DID });
    chain.put('identity.keyRecords', [SECONDARY], { SecondaryKey: DID });
    chain.put('identity.keyRecords', [SIGNER], { MultiSigSignerKey: PRIMARY });
    chain.put('identity.keyAssetPermissions', [SECONDARY], { Whole: null });
    chain.put('identity.keyExtrinsicPermissions', [SECONDARY], { Whole: null });
    chain.put('identity.keyPortfolioPermissions', [SECONDARY], {
      These: [{ did: DID, kind: { User: 1 } }],
    });
    chain.put('portfolio.portfolios', [DID, 1], 'Savings');
    chain.put('portfolio.portfolioCustodian', [{ did: DID, kind: { User: 1 } }], CUSTODIAN);
    // custody given back to the owner, which the chain keeps as the owner's own custody
    chain.put('portfolio.portfolios', [DID, 2], 'Own');
    chain.put('portfolio.portfolioCustodian', [{ did: DID, kind: { User: 2 } }], DID);
    await seedOf(chain, ['Identity', 'Account', 'IdentityKey', 'Portfolio']);
  });

  it('seeds each identity with its primary key and whether its keys are frozen', () => {
    expect(byId(chain.rows('Identity'))[DID]).toMatchObject({
      primaryAccountId: PRIMARY,
      secondaryKeysFrozen: true,
    });
    expect(byId(chain.rows('Identity'))[CUSTODIAN]).toMatchObject({ secondaryKeysFrozen: false });
  });

  it('adds the systematic issuers the records leave out', () => {
    expect(chain.rows('Identity')).toHaveLength(2 + 8);
  });

  it('skips a record with no primary key, and gives it no portfolio', () => {
    expect(byId(chain.rows('Identity'))[ASSET_DID]).toBeUndefined();
    expect(byId(chain.rows('Portfolio'))[`${ASSET_DID}/0`]).toBeUndefined();
  });

  it("seeds an account for each key, a multisig signer's with no identity", () => {
    const accounts = byId(chain.rows('Account'));
    expect(accounts[PRIMARY]).toMatchObject({ identityId: DID, keyRole: 'PrimaryKey' });
    expect(accounts[SECONDARY]).toMatchObject({ identityId: DID, keyRole: 'SecondaryKey' });
    expect(accounts[SIGNER]).toMatchObject({ keyRole: 'MultiSigSigner' });
    expect(accounts[SIGNER].identityId).toBeUndefined();
  });

  it('opens an interval for each identity key, a secondary key with its three permissions', () => {
    const keys = chain.rows('IdentityKey');
    expect(keys.map(({ accountId }) => accountId).sort()).toEqual([PRIMARY, SECONDARY].sort());
    expect(keys.find(({ accountId }) => accountId === SECONDARY)).toMatchObject({
      role: 'SecondaryKey',
      validFromBlockId: '0000001000',
      permissions: {
        assets: { type: 'whole' },
        transactions: { type: 'whole' },
        portfolios: { type: 'these', values: [{ did: DID, number: 1 }] },
      },
    });
  });

  it('seeds each default portfolio, and the user portfolios with their names and custodians', () => {
    const portfolios = byId(chain.rows('Portfolio'));
    expect(portfolios[`${DID}/0`]).toMatchObject({ identityId: DID, number: 0 });
    expect(portfolios[`${DID}/1`]).toMatchObject({ name: 'Savings', custodianId: CUSTODIAN });
    // an owner holding its own portfolio has no custodian, as the handlers record it
    expect(portfolios[`${DID}/2`].custodianId).toBeUndefined();
    expect(Object.keys(portfolios)).toHaveLength(2 + 8 + 2);
  });
});

describe('before 7.0', () => {
  it("takes a secondary key's permissions from its key record, the pair (did, permissions)", async () => {
    const DID = `0x${'01'.repeat(32)}`;
    const SECONDARY = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
    const chain = fakeChain(6_002_010);
    chain.put('identity.didRecords', [DID], { primaryKey: null });
    chain.put('identity.keyRecords', [SECONDARY], {
      SecondaryKey: [
        DID,
        { asset: { Whole: null }, extrinsic: { Whole: null }, portfolio: { Whole: null } },
      ],
    });

    await seedOf(chain, ['Account', 'IdentityKey']);

    expect(byId(chain.rows('Account'))[SECONDARY]).toMatchObject({
      identityId: DID,
      keyRole: 'SecondaryKey',
    });
    expect(chain.rows('IdentityKey')).toEqual([
      expect.objectContaining({
        accountId: SECONDARY,
        role: 'SecondaryKey',
        permissions: expect.objectContaining({
          assets: expect.objectContaining({ type: 'whole' }),
        }),
      }),
    ]);
  });
});

/**
 * An index keeps a row for every address it has seen, and a seed one for every account the chain
 * holds; an unlinked one only the index has is one the chain no longer holds
 */
it('counts an unlinked account the chain no longer holds as history, and a linked one not', () => {
  const accounts = SEEDERS.find(({ entity }) => entity === 'Account');
  expect(accounts?.terminal?.({ id: '', keyRole: 'Unlinked' } as never)).toBe(true);
  expect(
    accounts?.terminal?.({ id: '', keyRole: 'SecondaryKey', identityId: '0x01' } as never)
  ).toBe(false);
  expect(accounts?.terminal?.({ id: '', keyRole: 'MultiSigSigner' } as never)).toBe(false);
});
