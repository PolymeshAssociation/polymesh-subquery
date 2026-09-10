/**
 * Defect A8 — `portfolio.FungibleTokensMovedBetweenPortfolios` (6 args) and
 * `NFTsMovedBetweenPortfolios` (5 args) were emitted only at v5.4.3, through `unchecked_move_funds`,
 * and never registered. They are intra-Identity, so they write AssetTransaction rows with
 * isInternalTransfer: true, matching their v6+ successor's shape.
 */

import {
  handleFungibleTokensMovedBetweenPortfolios,
  handleNftsMovedBetweenPortfolios,
} from '../../src/mappings/entities/identities/mapPortfolio';
import { codec, MockDb, mockStore, portfolioCodec, tupleEvent } from './helpers';

const DID = '0x0a'.padEnd(66, '0');
const ADDR = '5Signer0000000000000000000000000000000000000000000';

const v5Event = (method: string, data: unknown[]) =>
  tupleEvent({
    section: 'portfolio',
    method,
    data,
    specVersion: 5_003_001,
    blockNumber: '7786536',
    extrinsic: {
      idx: 0,
      extrinsic: { signer: codec(ADDR), method: { section: 'portfolio', method: 'moveFunds' } },
    },
  });

describe('v5-era portfolio movement events', () => {
  let db: MockDb;

  beforeEach(() => {
    db = mockStore();
  });

  it('FungibleTokensMovedBetweenPortfolios writes an internal-transfer AssetTransaction', async () => {
    await handleFungibleTokensMovedBetweenPortfolios(
      v5Event('FungibleTokensMovedBetweenPortfolios', [
        codec(DID),
        portfolioCodec(DID, 0),
        portfolioCodec(DID, 2),
        codec('0x5449434b4552000000000000'),
        codec('999'),
        codec('note'),
      ])
    );

    const [row] = Object.values(db['AssetTransaction']);
    expect(row).toMatchObject({
      fromPortfolioId: `${DID}/0`,
      toPortfolioId: `${DID}/2`,
      fromIdentityId: DID,
      toIdentityId: DID,
      amount: BigInt(999),
      isInternalTransfer: true,
      memo: 'note',
      address: ADDR,
      eventId: 'FungibleTokensMovedBetweenPortfolios',
    });
    expect(row.nftIds).toBeUndefined();
  });

  it('NFTsMovedBetweenPortfolios writes an internal-transfer AssetTransaction with nftIds', async () => {
    await handleNftsMovedBetweenPortfolios(
      v5Event('NFTsMovedBetweenPortfolios', [
        codec(DID),
        portfolioCodec(DID, 0),
        portfolioCodec(DID, 1),
        codec({ ticker: '0x5449434b4552000000000000', ids: [4, 5] }),
        codec('gift'),
      ])
    );

    const [row] = Object.values(db['AssetTransaction']);
    expect(row).toMatchObject({
      fromIdentityId: DID,
      toIdentityId: DID,
      isInternalTransfer: true,
      nftIds: [BigInt(4), BigInt(5)],
      eventId: 'NFTsMovedBetweenPortfolios',
    });
    expect(row.amount).toBeUndefined();
  });
});
