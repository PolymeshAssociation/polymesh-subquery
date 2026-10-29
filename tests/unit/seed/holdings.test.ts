/**
 * Holdings and tokens: each portfolio's and account's position in an asset, each identity's across
 * them, each token where it is, and the allowances and approvals over them.
 */
import { SEED_EVENT_ID } from '../../../src/mappings/consts';
import { seed } from '../../../src/seed/seeder';
import { SEEDERS } from '../../../src/seed/seeders';
import { accountRows } from '../../../src/seed/seeders/identities';
import { snapshotAtParent } from '../../../src/seed/snapshot';
import { fakeChain, FakeChain } from './fakeChain';
import { byId } from './goldens';

const ASSET = '0x1234567890abcdef1234567890abcdef';
const NFTS = '0xfedcba0987654321fedcba0987654321';
const DID = `0x${'01'.repeat(32)}`;
const KEY = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const SPENDER = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const START = new Date('2026-01-01T00:00:00Z');

const ENTITIES = [
  'Holding',
  'AssetHolder',
  'Nft',
  'AssetAllowance',
  'NftApproval',
  'NftOperatorApproval',
];

const user = (number: number) => ({
  did: DID,
  kind: number ? { User: number } : { Default: null },
});

describe('from 8.1', () => {
  let chain: FakeChain;
  const rows = (entity: string) => byId(chain.rows(entity));

  beforeAll(async () => {
    chain = fakeChain(8_001_020);
    chain.put('identity.keyRecords', [KEY], { PrimaryKey: DID });
    chain.put('portfolio.portfolioAssetBalances', [user(0), ASSET], 100);
    chain.put('portfolio.portfolioAssetBalances', [user(2), ASSET], 25);
    chain.put('portfolio.portfolioFrozenAssets', [user(2), ASSET], 5);
    chain.put('portfolio.frozenPortfolios', [user(2), ASSET], true);
    chain.put('asset.assetBalance', [KEY, ASSET], 10);
    chain.put('asset.frozenBalance', [KEY, ASSET], 3);
    chain.put('asset.frozenAccounts', [KEY, ASSET], true);
    // the identity's own total, which the chain keeps apart from its portfolios'
    chain.put('asset.balanceOf', [ASSET, DID], 130);
    chain.put('nft.owner', [NFTS, 1], { Portfolio: user(0) });
    chain.put('nft.owner', [NFTS, 2], { Account: KEY });
    chain.put('nft.numberOfNFTs', [NFTS, DID], 2);
    chain.put('asset.allowances', [KEY, SPENDER, ASSET], 7);
    chain.put('nft.tokenApproval', [NFTS, 2], SPENDER);
    chain.put('nft.operatorApproval', [KEY, SPENDER, NFTS], true);

    await seed(
      snapshotAtParent(chain.block),
      {
        block: chain.block,
        blockId: '0000001000',
        eventId: SEED_EVENT_ID,
        datetime: START,
        specVersion: 8_001_020,
      },
      { seeders: SEEDERS.filter(({ entity }) => ENTITIES.includes(entity)), accountRows }
    );
  });

  it("seeds each portfolio's holding, with what's frozen and since the start", () => {
    expect(rows('Holding')[`${ASSET}/${DID}/0`]).toMatchObject({
      holderKind: 'Portfolio',
      portfolioId: `${DID}/0`,
      identityId: DID,
      assetHolderId: `${ASSET}/${DID}`,
      amount: '100',
      frozen: '0',
    });
    expect(rows('Holding')[`${ASSET}/${DID}/2`]).toMatchObject({
      amount: '25',
      frozen: '5',
      frozenSince: START.toISOString(),
    });
  });

  it("seeds each account's holding, under the identity its key belongs to", () => {
    expect(rows('Holding')[`${ASSET}/${KEY}`]).toMatchObject({
      holderKind: 'Account',
      accountId: KEY,
      identityId: DID,
      amount: '10',
      frozen: '3',
      frozenSince: START.toISOString(),
    });
  });

  it("takes an identity's position from the chain's own total, not the sum of its holdings", () => {
    expect(rows('AssetHolder')[`${ASSET}/${DID}`]).toMatchObject({
      identityId: DID,
      amount: '130',
      nftCount: 0,
    });
    expect(rows('AssetHolder')[`${NFTS}/${DID}`]).toMatchObject({ amount: '0', nftCount: 2 });
  });

  it('seeds each token in the holding it is in, which counts it', () => {
    expect(rows('Nft')[`${NFTS}/0000000001`]).toMatchObject({
      nftId: '1',
      holdingId: `${NFTS}/${DID}/0`,
    });
    expect(rows('Nft')[`${NFTS}/0000000002`]).toMatchObject({ holdingId: `${NFTS}/${KEY}` });
    expect(rows('Holding')[`${NFTS}/${DID}/0`]).toMatchObject({ nftCount: 1, amount: '0' });
  });

  it('seeds the allowances, their spending counted from the start', () => {
    expect(rows('AssetAllowance')[`${ASSET}/${KEY}/${SPENDER}`]).toMatchObject({
      amount: '7',
      totalSpent: '0',
    });
  });

  it("seeds a token's approval, owned by the account holding it, and an operator's", () => {
    expect(rows('NftApproval')[`${NFTS}/0000000002`]).toMatchObject({
      ownerId: KEY,
      spenderId: SPENDER,
    });
    expect(Object.keys(rows('NftOperatorApproval'))).toEqual([`${NFTS}/${KEY}/${SPENDER}`]);
  });

  it('gives every account they name an Account row', () => {
    expect(Object.keys(rows('Account')).sort()).toEqual([KEY, SPENDER].sort());
  });
});

describe('on 7.4', () => {
  // 7.4 copied every `nft.nftOwner` entry into `nft.owner` and kept writing both; testnet
  // 24,000,000 had 219 holdings whose tokens are in both
  it('counts a token both items name once', async () => {
    const chain = fakeChain(7_004_001);
    chain.put('nft.owner', [NFTS, 5], { Portfolio: user(1) });
    chain.put('nft.nftOwner', [NFTS, 5], user(1));
    await seed(
      snapshotAtParent(chain.block),
      {
        block: chain.block,
        blockId: '0000001000',
        eventId: SEED_EVENT_ID,
        datetime: START,
        specVersion: 7_004_001,
      },
      { seeders: SEEDERS.filter(({ entity }) => ['Holding', 'Nft'].includes(entity)), accountRows }
    );

    expect(chain.rows('Nft')).toHaveLength(1);
    expect(byId(chain.rows('Holding'))[`${NFTS}/${DID}/1`]).toMatchObject({ nftCount: 1 });
  });
});

describe('before 7.4', () => {
  it('finds a token in the portfolio `nft.nftOwner` names', async () => {
    const chain = fakeChain(7_002_000);
    chain.put('nft.nftOwner', [NFTS, 5], user(1));
    await seed(
      snapshotAtParent(chain.block),
      {
        block: chain.block,
        blockId: '0000001000',
        eventId: SEED_EVENT_ID,
        datetime: START,
        specVersion: 7_002_000,
      },
      { seeders: SEEDERS.filter(({ entity }) => ['Holding', 'Nft'].includes(entity)), accountRows }
    );

    expect(byId(chain.rows('Nft'))[`${NFTS}/0000000005`]).toMatchObject({
      holdingId: `${NFTS}/${DID}/1`,
    });
    expect(byId(chain.rows('Holding'))[`${NFTS}/${DID}/1`]).toMatchObject({ nftCount: 1 });
  });
});

describe('before 6.1', () => {
  // testnet 10,036,149: two tokens issued under 5.3, before `nft.nftOwner` existed
  it('finds a token in the portfolio `portfolio.portfolioNFT` flags', async () => {
    const chain = fakeChain(6_000_001);
    const ticker = `0x${Buffer.from('NFTS').toString('hex').padEnd(24, '0')}`;
    chain.put('portfolio.portfolioNFT', [user(1), [ticker, 1]], true);
    await seed(
      snapshotAtParent(chain.block),
      {
        block: chain.block,
        blockId: '0000001000',
        eventId: SEED_EVENT_ID,
        datetime: START,
        specVersion: 6_000_001,
      },
      { seeders: SEEDERS.filter(({ entity }) => ['Holding', 'Nft'].includes(entity)), accountRows }
    );

    const [nft] = chain.rows('Nft');
    expect(nft).toMatchObject({ nftId: BigInt(1) });
    expect(byId(chain.rows('Holding'))[nft.holdingId as string]).toMatchObject({
      portfolioId: `${DID}/1`,
      nftCount: 1,
    });
  });
});
