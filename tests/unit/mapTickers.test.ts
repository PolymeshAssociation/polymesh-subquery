/**
 * `handleTickerTransferred` (src/mappings/entities/assets/mapTickers.ts): before 6.0.0 the
 * transfer of a classic ticker came before its `ClassicTickerClaimed`, so the transfer reserves it.
 */
import { stringToHex, stringToU8a } from '@polkadot/util';
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

describe('linking and unlinking a ticker, as the chain records it', () => {
  const ASSET = '0x1234567890abcdef1234567890abcdef';
  let db: MockDb;

  beforeEach(() => {
    db = mockStore({
      Asset: { [ASSET]: { id: ASSET, assetId: ASSET } },
      TickerReservation: {
        ACME: { id: 'ACME', ticker: 'ACME', identityId: OLD_OWNER, expiry: new Date(5) },
      },
    });
  });

  const linkEvent = (method: string) =>
    tupleEvent({
      section: 'asset',
      method,
      specVersion: 7_000_003,
      blockNumber: '500',
      idx: 2,
      data: [codec(OLD_OWNER), codec(stringToHex('ACME'.padEnd(12, '\0'))), codec(ASSET)],
    });

  it('clears the expiry when the ticker is linked, as the chain does', async () => {
    await handleTickerLinkedToAsset(linkEvent('TickerLinkedToAsset'));

    expect(db.TickerReservation.ACME).toMatchObject({ assetId: ASSET, expiry: null });
    expect(db.Asset[ASSET]).toMatchObject({ ticker: 'ACME' });
  });

  it('removes the reservation when the ticker is unlinked, as the chain removes the registration', async () => {
    db.TickerReservation.ACME.assetId = ASSET;
    db.Asset[ASSET].ticker = 'ACME';

    await handleTickerUnlinkedFromAsset(linkEvent('TickerUnlinkedFromAsset'));

    expect(db.TickerReservation.ACME).toBeUndefined();
    expect(db.Asset[ASSET].ticker).toBeUndefined();
  });
});
