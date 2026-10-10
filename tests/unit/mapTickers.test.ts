/**
 * `handleTickerTransferred` (src/mappings/entities/assets/mapTickers.ts): before 6.0.0 the
 * transfer of a classic ticker came before its `ClassicTickerClaimed`, so the transfer reserves it.
 */
import { stringToU8a } from '@polkadot/util';
import {
  handleTickerLinkedToAsset,
  handleTickerTransferred,
  handleTickerUnlinkedFromAsset,
} from '../../src/mappings/entities/assets/mapTickers';
import { codec, MockDb, mockStore, tupleEvent } from './helpers';

const OLD_OWNER = '0x0a'.padEnd(66, '0');
const NEW_OWNER = '0x0b'.padEnd(66, '0');
const ticker = (text: string) => ({ ...codec(text), toU8a: () => stringToU8a(text) });

const transferred = (specVersion: number) =>
  tupleEvent({
    section: 'asset',
    method: 'TickerTransferred',
    specVersion,
    blockNumber: '200',
    idx: 3,
    data: [codec(NEW_OWNER), ticker('CLASSIC'), codec(OLD_OWNER)],
  });

describe('handleTickerTransferred', () => {
  let db: MockDb;

  beforeEach(() => {
    db = mockStore();
  });

  it('reserves a classic ticker the index has not seen, for its new owner', async () => {
    await handleTickerTransferred(transferred(5_000_000));

    expect(db['TickerReservation']['CLASSIC']).toMatchObject({
      ticker: 'CLASSIC',
      identityId: NEW_OWNER,
      createdEventId: '0000000200/0000000003',
    });
  });

  it('moves a reserved ticker to its new owner', async () => {
    db['TickerReservation'] = {
      CLASSIC: { id: 'CLASSIC', ticker: 'CLASSIC', identityId: OLD_OWNER },
    };

    await handleTickerTransferred(transferred(6_000_000));

    expect(db['TickerReservation']['CLASSIC']).toMatchObject({
      identityId: NEW_OWNER,
      updatedEventId: '0000000200/0000000003',
    });
  });
});

describe('ticker links on an index that started after the ticker was registered', () => {
  const ASSET = '0x87b4'.padEnd(34, '0');
  let db: MockDb;

  const linkEvent = (method: string) =>
    tupleEvent({
      section: 'asset',
      method,
      specVersion: 7_003_003,
      blockNumber: '20020139',
      idx: 2,
      data: [codec(OLD_OWNER), ticker('TicTicTicker'), codec(ASSET)],
    });

  beforeEach(() => {
    db = mockStore({
      Asset: { [ASSET]: { id: ASSET, assetId: ASSET, ticker: 'TicTicTicker' } },
      Identity: { [NEW_OWNER]: { id: NEW_OWNER } },
    });
    (globalThis as any).api.query = {
      asset: {
        uniqueTickerRegistration: jest
          .fn()
          .mockResolvedValue(codec({ owner: NEW_OWNER, expiry: null })),
      },
    };
  });

  it('builds the reservation from chain storage when linking', async () => {
    await handleTickerLinkedToAsset(linkEvent('TickerLinkedToAsset'));

    expect(db['TickerReservation']['TicTicTicker']).toMatchObject({
      identityId: NEW_OWNER,
      assetId: ASSET,
      createdEventId: '0020020139/0000000002',
    });
  });

  it('unlinks the asset without a reservation to unlink', async () => {
    await handleTickerUnlinkedFromAsset(linkEvent('TickerUnlinkedFromAsset'));

    expect(db['Asset'][ASSET].ticker).toBeUndefined();
    expect(db['TickerReservation']?.['TicTicTicker']).toBeUndefined();
  });
});
