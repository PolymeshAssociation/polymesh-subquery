import {
  __resetNftBuffer,
  handleLegacyNftIssued,
  handleLegacyNftRedeemed,
} from '../../src/mappings/entities/assets/mapNfts';
import { mapExternalAgentAction } from '../../src/mappings/entities/externalAgents/mapExternalAgentAction';
import { IndexerAnomaly } from '../../src/types';
import { getAssetId } from '../../src/utils';
import { codec, mockBulkWrites, mockStore, tupleEvent } from './helpers';

const SPEC = 5_003_000;
const TICKER_HEX = '0x544553544e4654000000000000';

/**
 * Before 6.0, minting and burning an NFT reported only `IssuedNFT` / `RedeemedNFT` — the holdings
 * event came later — so a pre-6.0 token was missing from every holding, supply and count. Issuance
 * names the collection rather than the asset, and neither event names the portfolio; the call does.
 */
describe('pre-6.0 NFT issuance and redemption', () => {
  const nftCall = (method: 'issueNft' | 'redeemNft', portfolioKind: unknown) => ({
    idx: 1,
    extrinsic: {
      method: {
        section: 'nft',
        method,
        args: [codec(TICKER_HEX), codec([]), codec(portfolioKind)],
      },
    },
  });

  const issued = (extrinsic: unknown, collectionId = 2) =>
    tupleEvent({
      section: 'nft',
      method: 'IssuedNFT',
      data: [codec(TEST_DID), codec(collectionId), codec(7)],
      specVersion: SPEC,
      extrinsic,
    });

  let assetId: string;

  beforeEach(async () => {
    __resetNftBuffer();
    assetId = await getAssetId(TICKER_HEX, { specVersion: SPEC } as never);
  });

  const seeded = () => {
    const db = mockStore({
      Asset: {
        [assetId]: {
          id: assetId,
          totalSupply: BigInt(0),
          totalTransfers: BigInt(0),
          holderCount: 0,
          isNftCollection: true,
        },
      },
    });
    mockBulkWrites(db, 'Nft');
    (globalThis as any).api.query = {
      nft: {
        collection: jest.fn(async (id: number) => ({
          toJSON: () => (id === 2 ? { id: 2, ticker: TICKER_HEX } : null),
        })),
      },
    };

    return db;
  };

  it('mints into the portfolio the call named, and counts it everywhere the holdings event would', async () => {
    const db = seeded();

    await handleLegacyNftIssued(issued(nftCall('issueNft', { user: 2 })));

    expect(db.Nft[`${assetId}/0000000007`]).toMatchObject({ portfolioId: `${TEST_DID}/2` });
    expect(db.Holding[`${assetId}/${TEST_DID}/2`].nftCount).toBe(1);
    expect(db.Asset[assetId].totalSupply).toBe(BigInt(1));
    expect(db.NftHolder[`${assetId}/${TEST_DID}`].nftIds).toEqual([BigInt(7)]);
  });

  it('reports and skips an issuance whose collection the chain has no asset for', async () => {
    const db = seeded();
    const anomaly = jest.spyOn(IndexerAnomaly.prototype, 'save').mockResolvedValue(undefined);

    await handleLegacyNftIssued(issued(nftCall('issueNft', { default: null }), 99));

    expect(db.Nft).toBeUndefined();
    expect(anomaly).toHaveBeenCalled();
  });

  it('assumes the default portfolio, and says so, for an issuance made inside another call', async () => {
    const db = seeded();
    const anomaly = jest.spyOn(IndexerAnomaly.prototype, 'save').mockResolvedValue(undefined);

    await handleLegacyNftIssued(
      issued({ idx: 1, extrinsic: { method: { section: 'utility', method: 'batch', args: [] } } })
    );

    expect(db.Nft[`${assetId}/0000000007`]).toMatchObject({ portfolioId: `${TEST_DID}/0` });
    expect(anomaly).toHaveBeenCalled();
  });

  it('burns a redeemed token out of the portfolio the call named', async () => {
    const db = seeded();

    await handleLegacyNftIssued(issued(nftCall('issueNft', { user: 2 })));
    await handleLegacyNftRedeemed(
      tupleEvent({
        section: 'nft',
        method: 'RedeemedNFT',
        data: [codec(TEST_DID), codec(TICKER_HEX), codec(7)],
        specVersion: SPEC,
        extrinsic: nftCall('redeemNft', { user: 2 }),
        blockNumber: '1001',
      })
    );

    expect(db.Nft[`${assetId}/0000000007`].burnedEventId).toBeDefined();
    expect(db.Holding[`${assetId}/${TEST_DID}/2`].nftCount).toBe(0);
    expect(db.Asset[assetId].totalSupply).toBe(BigInt(0));
  });

  /** Issuance is an agent-permissioned call, so it belongs in the asset's agent history. */
  it('records the issuance as an agent action on the asset its collection belongs to', async () => {
    const db = seeded();

    await mapExternalAgentAction(issued(nftCall('issueNft', { user: 2 })));

    expect(Object.values(db.AssetAgentAction ?? {})).toEqual([
      expect.objectContaining({
        assetId,
        palletName: 'nft',
        eventId: 'IssuedNFT',
        callerId: TEST_DID,
      }),
    ]);
  });
});
