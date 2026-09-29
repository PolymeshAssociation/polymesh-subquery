import {
  __resetNftBuffer,
  flushNftBuffer,
  handleNftHoldingsUpdates,
} from '../../src/mappings/entities/assets/mapNfts';
import {
  handleNftApproval,
  handleNftApprovalForAll,
  handleNftApprovalSpent,
} from '../../src/mappings/entities/assets/mapNftApprovals';
import {
  codec,
  meshPortfolioHolderCodec,
  mockBulkWrites,
  mockStore,
  namedEvent,
  storeRemove,
  tupleEvent,
} from './helpers';

const SPEC = 8_001_020;
const ASSET = '0xcollection0000000000000000000000';
const OWNER = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const SPENDER = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const OPERATOR = '5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y';
const TOKEN = `${ASSET}/0000000007`;
const OPERATOR_ROW = `${ASSET}/${OWNER}/${OPERATOR}`;

const accounts = {
  [OWNER]: { id: OWNER, identityId: TEST_DID },
  [SPENDER]: { id: SPENDER },
  [OPERATOR]: { id: OPERATOR },
};

const approval = (spender: string | null, blockNumber = '1000') =>
  namedEvent({
    section: 'nft',
    method: 'NFTApproval',
    fields: { owner: OWNER, spender, asset_id: ASSET, nft_id: 7 },
    specVersion: SPEC,
    blockNumber,
  });

const approvalForAll = (approved: boolean) =>
  namedEvent({
    section: 'nft',
    method: 'NFTApprovalForAll',
    fields: { owner: OWNER, operator: OPERATOR, asset_id: ASSET, approved },
    specVersion: SPEC,
  });

describe('per-token approvals', () => {
  it('records the spender a holder approved for one token', async () => {
    const db = mockStore({ Account: accounts, Nft: { [TOKEN]: { id: TOKEN } } });

    await handleNftApproval(approval(SPENDER));

    expect(db.NftApproval[TOKEN]).toMatchObject({
      nftId: TOKEN,
      assetId: ASSET,
      ownerId: OWNER,
      spenderId: SPENDER,
    });
  });

  it('replaces the spender on a new approval but keeps the row it started as', async () => {
    const db = mockStore({ Account: accounts, Nft: { [TOKEN]: { id: TOKEN } } });

    await handleNftApproval(approval(SPENDER, '1000'));
    await handleNftApproval(approval(OPERATOR, '1001'));

    expect(db.NftApproval[TOKEN].spenderId).toBe(OPERATOR);
    expect(db.NftApproval[TOKEN].createdEventId).toBe('0000001000/0000000000');
    expect(db.NftApproval[TOKEN].updatedEventId).toBe('0000001001/0000000000');
  });

  it('removes the approval when the holder names no spender', async () => {
    const db = mockStore({ Account: accounts, NftApproval: { [TOKEN]: { id: TOKEN } } });

    await handleNftApproval(approval(null));

    expect(db.NftApproval[TOKEN]).toBeUndefined();
  });

  it('removes the approval once the spender uses it', async () => {
    const db = mockStore({ NftApproval: { [TOKEN]: { id: TOKEN } } });

    await handleNftApprovalSpent(
      namedEvent({
        section: 'nft',
        method: 'NFTApprovalSpent',
        fields: { owner: OWNER, spender: SPENDER, asset_id: ASSET, nft_id: 7 },
        specVersion: SPEC,
      })
    );

    expect(db.NftApproval[TOKEN]).toBeUndefined();
  });
});

describe('operator approvals', () => {
  it('holds a row exactly while the approval is set', async () => {
    const db = mockStore({ Account: accounts });

    await handleNftApprovalForAll(approvalForAll(true));

    expect(db.NftOperatorApproval[OPERATOR_ROW]).toMatchObject({
      assetId: ASSET,
      ownerId: OWNER,
      operatorId: OPERATOR,
    });

    await handleNftApprovalForAll(approvalForAll(false));

    expect(db.NftOperatorApproval[OPERATOR_ROW]).toBeUndefined();
  });
});

/**
 * The chain drops a per-token approval whenever the token leaves the account holding it, with no
 * event of its own — so the NFT holdings handler is the only place that can clear it. A portfolio
 * cannot hold an approval at all, so a token leaving one must not cost a removal.
 */
describe('the silent clear on a transfer', () => {
  const transfer = (from: unknown) =>
    tupleEvent({
      section: 'nft',
      method: 'NFTHoldingsUpdated',
      specVersion: SPEC,
      blockNumber: '2000',
      idx: 1,
      data: [
        codec(TEST_DID),
        codec({ assetId: ASSET, ids: [7] }),
        from,
        meshPortfolioHolderCodec(TEST_DID, 1),
        codec({ transferred: { instructionId: '9', instructionMemo: null } }),
      ],
    });

  const seeded = () => {
    __resetNftBuffer();
    const db = mockStore({
      Account: accounts,
      Asset: {
        [ASSET]: {
          id: ASSET,
          totalSupply: BigInt(1),
          totalTransfers: BigInt(0),
          holderCount: 1,
          isNftCollection: true,
        },
      },
      Nft: { [TOKEN]: { id: TOKEN, assetId: ASSET, nftId: BigInt(7) } },
      NftApproval: { [TOKEN]: { id: TOKEN, ownerId: OWNER, spenderId: SPENDER } },
    });
    mockBulkWrites(db, 'Nft');

    return db;
  };

  it('clears the approval when the token leaves the account that granted it', async () => {
    const db = seeded();

    await handleNftHoldingsUpdates(transfer(codec({ account: OWNER })));
    await flushNftBuffer();

    expect(db.NftApproval[TOKEN]).toBeUndefined();
  });

  it('does not touch approvals when the token leaves a portfolio', async () => {
    seeded();

    await handleNftHoldingsUpdates(transfer(meshPortfolioHolderCodec(TEST_DID, 0)));
    await flushNftBuffer();

    expect(storeRemove().mock.calls.filter(([entity]) => entity === 'NftApproval')).toEqual([]);
  });
});
