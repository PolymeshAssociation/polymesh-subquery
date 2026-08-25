/**
 * Unit tests for the authorization payload repair.
 *
 * The chain's v6 to v7 `ticker_migrations` rewrote `TransferAssetOwnership`/`BecomeAgent` payloads
 * from tickers to asset ids without emitting an event, so rows indexed before that upgrade still
 * name a ticker. The asset id is derivable from the ticker, so the repair needs no chain access.
 */

import { SubstrateBlock } from '@subql/types';
import {
  legacyTickerOf,
  needsAssetIdRepair,
  repairAuthorizationsAfterUpgrade,
  withAssetId,
} from '../../src/mappings/entities/identities/repairAuthorizations';
import { Authorization, AuthorizationStatusEnum } from '../../src/types';

/** "T1" as it is actually stored on chain - trailing spaces, not NULs */
const LEGACY_TICKER = '0x543120202020202020202020';
/** `AssetId::from(Ticker)` for the above, as observed on live testnet for authorization 54631 */
const ASSET_ID = '0x7edf86b7e651823cb21c2574e61c6ff3';
const OTHER_ASSET_ID = '0x9d2c625f0a46803e9e982a644dab6fa7';

const globalAny = globalThis as any;

const makeBlock = (specVersion = 7000005): SubstrateBlock =>
  ({
    specVersion,
    block: { header: { number: { toString: () => '123456' } } },
  } as unknown as SubstrateBlock);

const makeRow = (overrides: Partial<Authorization> = {}): Authorization =>
  Authorization.create({
    id: '54631',
    type: 'TransferAssetOwnership' as Authorization['type'],
    fromId: '0xfrom',
    toId: '0xtarget',
    status: AuthorizationStatusEnum.Pending,
    createdBlockId: '0010000000',
    updatedBlockId: '0010000000',
    createdEventId: '0010000000/0000',
    data: JSON.stringify(LEGACY_TICKER),
    ...overrides,
  });

describe('legacyTickerOf', () => {
  it('reads a bare ticker payload (transferAssetOwnership)', () => {
    expect(legacyTickerOf(JSON.stringify(LEGACY_TICKER))).toEqual(LEGACY_TICKER);
  });

  it('reads the ticker at the head of a pair (becomeAgent)', () => {
    expect(legacyTickerOf(JSON.stringify([LEGACY_TICKER, { full: null }]))).toEqual(LEGACY_TICKER);
  });

  it('ignores a payload that already names an asset id', () => {
    expect(legacyTickerOf(JSON.stringify(ASSET_ID))).toBeUndefined();
    expect(legacyTickerOf(JSON.stringify([ASSET_ID, { full: null }]))).toBeUndefined();
  });

  it('ignores null, malformed and non-hex payloads', () => {
    expect(legacyTickerOf(null)).toBeUndefined();
    expect(legacyTickerOf('not json')).toBeUndefined();
    expect(legacyTickerOf(JSON.stringify({ did: '0xabc' }))).toBeUndefined();
    expect(legacyTickerOf(JSON.stringify(42))).toBeUndefined();
  });
});

describe('withAssetId', () => {
  it('replaces a bare payload', () => {
    expect(withAssetId(JSON.stringify(LEGACY_TICKER), ASSET_ID)).toEqual(JSON.stringify(ASSET_ID));
  });

  it('replaces the head of a pair and keeps the agent group', () => {
    expect(withAssetId(JSON.stringify([LEGACY_TICKER, { full: null }]), ASSET_ID)).toEqual(
      JSON.stringify([ASSET_ID, { full: null }])
    );
  });
});

describe('needsAssetIdRepair', () => {
  const pending = AuthorizationStatusEnum.Pending;

  it('accepts a pending migrated-type row still naming a ticker', () => {
    expect(
      needsAssetIdRepair({
        status: pending,
        type: 'TransferAssetOwnership',
        data: JSON.stringify(LEGACY_TICKER),
      })
    ).toBe(true);
    expect(
      needsAssetIdRepair({
        status: pending,
        type: 'BecomeAgent',
        data: JSON.stringify([LEGACY_TICKER, { full: null }]),
      })
    ).toBe(true);
  });

  it('rejects a row already carrying an asset id, so re-runs are no-ops', () => {
    expect(
      needsAssetIdRepair({
        status: pending,
        type: 'TransferAssetOwnership',
        data: JSON.stringify(ASSET_ID),
      })
    ).toBe(false);
  });

  it('rejects types the migration never rewrote', () => {
    for (const type of ['TransferTicker', 'PortfolioCustody', 'JoinIdentity']) {
      expect(
        needsAssetIdRepair({ status: pending, type, data: JSON.stringify(LEGACY_TICKER) })
      ).toBe(false);
    }
  });

  it('rejects rows that are no longer pending', () => {
    for (const status of [
      AuthorizationStatusEnum.Consumed,
      AuthorizationStatusEnum.Rejected,
      AuthorizationStatusEnum.Revoked,
    ]) {
      expect(
        needsAssetIdRepair({
          status,
          type: 'TransferAssetOwnership',
          data: JSON.stringify(LEGACY_TICKER),
        })
      ).toBe(false);
    }
  });
});

describe('repairAuthorizationsAfterUpgrade', () => {
  beforeEach(() => {
    globalAny.chainId = '0xnotstaging';
    jest.spyOn(globalAny.store, 'getByField').mockResolvedValue([]);
    jest.spyOn(globalAny.store, 'bulkUpdate').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const withRows = (rows: Authorization[]) => globalAny.store.getByField.mockResolvedValue(rows);

  it('derives the migrated asset id without reading chain state', async () => {
    withRows([makeRow()]);

    await repairAuthorizationsAfterUpgrade(makeBlock());

    const [entity, saved] = globalAny.store.bulkUpdate.mock.calls[0];
    expect(entity).toBe('Authorization');
    // the exact value the chain migration produced for this authorization
    expect(saved[0].data).toBe(JSON.stringify(ASSET_ID));
    expect(saved[0].updatedBlockId).toBe('0000123456');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps the agent group when repairing a becomeAgent payload', async () => {
    withRows([
      makeRow({
        type: 'BecomeAgent' as Authorization['type'],
        data: JSON.stringify([LEGACY_TICKER, { full: null }]),
      }),
    ]);

    await repairAuthorizationsAfterUpgrade(makeBlock());

    const [, saved] = globalAny.store.bulkUpdate.mock.calls[0];
    expect(saved[0].data).toBe(JSON.stringify([ASSET_ID, { full: null }]));
  });

  it('writes nothing when every row already carries an asset id (idempotent re-run)', async () => {
    withRows([makeRow({ data: JSON.stringify(ASSET_ID) })]);

    await repairAuthorizationsAfterUpgrade(makeBlock());

    expect(globalAny.store.bulkUpdate).not.toHaveBeenCalled();
  });

  it('applies the staging chain exception, which migrated without UUID normalisation', async () => {
    globalAny.chainId = '0x3c3183f6d701500766ff7d147b79c4f10014a095eaaa98e960dcef6b3ead50ee';
    withRows([makeRow()]);

    await repairAuthorizationsAfterUpgrade(makeBlock());

    const [, saved] = globalAny.store.bulkUpdate.mock.calls[0];
    // same blake2 digest, without the version and variant bits forced
    expect(saved[0].data).toBe(JSON.stringify('0x7edf86b7e651123cb21c2574e61c6ff3'));
  });

  it('does nothing on chains predating the asset-id migration', async () => {
    // the v6 -> v7 `ticker_migrations` is what rewrote the payloads, so 6.x is still ticker-only
    await repairAuthorizationsAfterUpgrade(makeBlock(6002000));

    expect(globalAny.store.getByField).not.toHaveBeenCalled();
    expect(globalAny.store.bulkUpdate).not.toHaveBeenCalled();
  });

  it('does not touch a row whose ticker differs, guarding the derivation', async () => {
    withRows([makeRow({ data: JSON.stringify('0x543100000000000000000000') })]);

    await repairAuthorizationsAfterUpgrade(makeBlock());

    const [, saved] = globalAny.store.bulkUpdate.mock.calls[0];
    // NUL padded "T1" is a different ticker, and derives to a different asset
    expect(saved[0].data).toBe(JSON.stringify(OTHER_ASSET_ID));
  });
});
