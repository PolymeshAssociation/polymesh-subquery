/**
 * `handleTickerTransferred` (src/mappings/entities/assets/mapTickers.ts): before 6.0.0 the
 * transfer of a classic ticker came before its `ClassicTickerClaimed`, so the transfer reserves it.
 */
import { stringToU8a } from '@polkadot/util';
import { handleTickerTransferred } from '../../src/mappings/entities/assets/mapTickers';
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
