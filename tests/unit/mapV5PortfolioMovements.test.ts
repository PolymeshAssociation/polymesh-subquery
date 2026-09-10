/**
 * Defect A8 — `portfolio.FungibleTokensMovedBetweenPortfolios` (6 args) and
 * `NFTsMovedBetweenPortfolios` (5 args) were emitted only at v5.4.3, through `unchecked_move_funds`,
 * and never registered. They are intra-Identity, so they write AssetTransaction rows with
 * isInternalTransfer: true, matching their v6+ successor's shape.
 */

import { SubstrateEvent } from '@subql/types';
import {
  handleFungibleTokensMovedBetweenPortfolios,
  handleNftsMovedBetweenPortfolios,
} from '../../src/mappings/entities/identities/mapPortfolio';

const DID = '0x0a'.padEnd(66, '0');
const ADDR = '5Signer0000000000000000000000000000000000000000000';

const storeGet = (): jest.Mock => (globalThis as any).store.get as jest.Mock;
const storeSet = (): jest.Mock => (globalThis as any).store.set as jest.Mock;

const codec = (value: unknown) => ({
  toString: () => (typeof value === 'string' ? value : JSON.stringify(value)),
  toJSON: () => value,
});

const portfolioCodec = (did: string, number: number) =>
  codec({ did, kind: number ? { user: number } : { default: null } });

const v5Event = (method: string, data: ReturnType<typeof codec>[]): SubstrateEvent =>
  ({
    idx: 0,
    extrinsic: {
      idx: 0,
      extrinsic: { signer: codec(ADDR), method: { section: 'portfolio', method: 'moveFunds' } },
    },
    block: {
      block: { header: { number: { toString: () => '7786536' } } },
      specVersion: 5003001,
      timestamp: new Date('2022-01-01T00:00:00Z'),
    },
    event: {
      section: 'portfolio',
      method,
      data,
      meta: {
        fields: data.map(() => ({
          name: { isSome: false },
          typeName: { isSome: true, unwrap: () => codec('Dummy') },
        })),
      },
    },
  } as unknown as SubstrateEvent);

describe('v5-era portfolio movement events', () => {
  let db: Record<string, Record<string, any>>;

  beforeEach(() => {
    db = {};
    storeGet().mockImplementation((entity: string, id: string) =>
      Promise.resolve(db[entity]?.[id])
    );
    storeSet().mockImplementation((entity: string, id: string, data: any) => {
      (db[entity] ??= {})[id] = { ...data };
      return Promise.resolve();
    });
    (globalThis as any).api.query = {};
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
