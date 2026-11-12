/**
 * What the chain does to a ticker's registration with no ticker event: an asset created on its
 * ticker before 7.0 makes the registration permanent and links it, and the registration follows the
 * asset to a new owner.
 */
import { handleAssetOwnershipTransferred } from '../../src/mappings/entities/assets/mapAsset';
import { handleTickerOfNewAsset } from '../../src/mappings/entities/assets/mapTickers';
import { getAssetIdForLegacyTicker } from '../../src/utils/assets';
import { codec, mockStore, tupleEvent } from './helpers';

const OWNER = `0x${'01'.repeat(32)}`;
const BUYER = `0x${'02'.repeat(32)}`;
const TICKER = '0x41434d450000000000000000';

describe('an asset created on its ticker before 7.0', () => {
  const created = tupleEvent({
    section: 'asset',
    method: 'AssetCreated',
    specVersion: 6_002_010,
    data: [
      codec(OWNER),
      codec(TICKER),
      codec(true),
      codec('EquityCommon'),
      codec(OWNER),
      codec('0x'),
      codec([]),
      codec(null),
    ],
  });

  it('links the registration to the asset, with no expiry', async () => {
    const db = mockStore({
      TickerReservation: {
        ACME: { id: 'ACME', ticker: 'ACME', identityId: OWNER, expiry: new Date(1) },
      },
    });

    await handleTickerOfNewAsset(created);

    expect(db.TickerReservation.ACME).toMatchObject({
      assetId: await getAssetIdForLegacyTicker(TICKER),
      expiry: null,
      identityId: OWNER,
    });
  });

  it('registers a ticker no one reserved, as creating the asset did', async () => {
    const db = mockStore();

    await handleTickerOfNewAsset(created);

    expect(db.TickerReservation.ACME).toMatchObject({ ticker: 'ACME', identityId: OWNER });
  });
});

it("moves an asset's ticker to its new owner", async () => {
  const ASSET = `0x${'aa'.repeat(16)}`;
  const db = mockStore({
    Asset: { [ASSET]: { id: ASSET, ticker: 'ACME', ownerId: OWNER } },
    TickerReservation: { ACME: { id: 'ACME', ticker: 'ACME', identityId: OWNER, assetId: ASSET } },
  });

  await handleAssetOwnershipTransferred(
    tupleEvent({
      section: 'asset',
      method: 'AssetOwnershipTransferred',
      data: [codec(BUYER), codec(ASSET), codec(OWNER)],
    })
  );

  expect(db.Asset[ASSET].ownerId).toBe(BUYER);
  expect(db.TickerReservation.ACME.identityId).toBe(BUYER);
});
