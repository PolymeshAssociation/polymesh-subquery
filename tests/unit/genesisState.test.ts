/**
 * What the genesis config sets with no event, which the genesis handler reads from the genesis
 * state: the system identities' keys and the tickers reserved for fiat currencies and for Polymath
 * classic tickers (testnet: 170 and 231 of `asset.tickers` at block 0).
 */
import {
  handleGenesisDids,
  handleGenesisTickers,
} from '../../src/mappings/migrations/genesisHandler';
import { codec, mockStore } from './helpers';

const SEED = '0000000000/0000000000';
const FIAT = '0x73797374656d3a666961745f7469636b6572735f7265736572766174696f6e00';
const CLASSIC = '0x73797374656d3a706f6c796d6174685f636c61737369635f6d69670000000000';
const PLN = '0x504c4e000000000000000000';
const ACME = '0x41434d450000000000000000';

const registrations = (entries: [string, Record<string, unknown>][]) =>
  jest
    .fn()
    .mockResolvedValue(entries.map(([ticker, value]) => [{ args: [codec(ticker)] }, codec(value)]));

describe('handleGenesisTickers', () => {
  it('reserves every ticker the genesis config registered, for its owner', async () => {
    const db = mockStore();
    (globalThis as any).api.query = {
      asset: {
        tickers: {
          entries: registrations([
            [PLN, { owner: FIAT, expiry: null }],
            [ACME, { owner: CLASSIC, expiry: 1_700_000_000_000 }],
          ]),
        },
      },
    };

    await handleGenesisTickers(SEED);

    expect(db.TickerReservation.PLN).toMatchObject({
      ticker: 'PLN',
      identityId: FIAT,
      createdEventId: SEED,
    });
    expect(db.TickerReservation.PLN.expiry).toBeUndefined();
    expect(db.TickerReservation.ACME).toMatchObject({
      identityId: CLASSIC,
      expiry: new Date(1_700_000_000_000),
    });
  });

  it('reads the registrations under their 7.0 name on a chain that starts there', async () => {
    const db = mockStore();
    (globalThis as any).api.query = {
      asset: {
        uniqueTickerRegistration: {
          entries: registrations([[PLN, { owner: FIAT, expiry: null }]]),
        },
      },
    };

    await handleGenesisTickers(SEED);

    expect(db.TickerReservation.PLN).toMatchObject({ identityId: FIAT });
  });
});

describe('handleGenesisDids', () => {
  const DID_4 = '0x04'.padEnd(66, '0');
  const PRIMARY = '5Ci94GCJC2JBM8U1PCkpHX6HkscWmucN9XwUrjb7o4TDgVns';
  const SECONDARY = '5E22DKgvdQwF8d7dAFNs33HrGybSVFAUHkz7KhjLoSzxqufd';

  it("opens a genesis secondary key with the permissions the identity's record gives it", async () => {
    const db = mockStore();
    (globalThis as any).api.registry = { chainSS58: 42 };
    (globalThis as any).api.query = {
      identity: {
        didRecords: {
          multi: jest.fn(async (dids: string[]) =>
            dids.map(did =>
              codec(
                did === DID_4
                  ? {
                      primary_key: PRIMARY,
                      secondary_keys: [
                        {
                          signer: { account: SECONDARY },
                          permissions: {
                            asset: { whole: null },
                            extrinsic: { whole: null },
                            portfolio: { whole: null },
                          },
                        },
                      ],
                    }
                  : null
              )
            )
          ),
        },
      },
    };

    await handleGenesisDids();

    const keys = Object.values(db.IdentityKey) as any[];
    expect(keys.find(key => key.accountId === SECONDARY).permissions).toEqual({
      assets: { type: 'whole', values: null },
      portfolios: { type: 'whole', values: undefined },
      transactions: { type: 'whole', values: null },
      transactionGroups: [],
    });
    expect(keys.find(key => key.accountId === PRIMARY).permissions).toBeUndefined();
  });
});
