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
    createdEventId: '0010000000/0000000000',
    updatedEventId: '0010000000/0000000000',
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
