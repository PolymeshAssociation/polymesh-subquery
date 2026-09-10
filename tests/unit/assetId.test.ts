/**
 * `getAssetId` maps a raw `asset` event identifier to the id the `Asset` row is keyed on.
 *
 * The public chain switched `asset` events from a 12-byte `Ticker` to a 16-byte
 * `PolymeshPrimitivesAssetAssetId` at v7.0.0. The switch was gated on the block's spec version —
 * but `@subql/node` was seen serving the pre-upgrade spec (6003050) for ~169k blocks after
 * v7.0.0 actually activated on testnet (block 15,978,579 onward), so an already-migrated
 * 16-byte asset id in one of those blocks was run through `getAssetIdForLegacyTicker` and
 * blake2-hashed into a bogus id — its `Asset` lookup then missed (`MissingReferencedEntity`).
 *
 * The fix disambiguates by byte length: a `Ticker` is `[u8; 12]`, so a 16-byte value is a
 * migrated asset id whatever spec the block claims.
 */

import { SubstrateBlock } from '@subql/types';
import { getAssetId, getAssetIdForLegacyTicker, isMigratedAssetId } from '../../src/utils/assets';

const globalAny = globalThis as any;

const block = (specVersion: number): SubstrateBlock =>
  ({ specVersion } as unknown as SubstrateBlock);

/** A 16-byte migrated asset id (ticker "PSRF" as it exists on testnet from v7.0.0). */
const ASSET_ID = '0x8f68f310c5ea8f27a189154812efd457';
/** "PSRF" as a 12-byte ticker, hex (0x + 24 chars). */
const TICKER_HEX = '0x505352460000000000000000';

beforeEach(() => {
  globalAny.chainId = '0xnotstaging';
  globalAny.api.runtimeVersion.specName = { toString: () => 'polymesh' };
});

describe('isMigratedAssetId', () => {
  it('is true only for a 16-byte hex value', () => {
    expect(isMigratedAssetId(ASSET_ID)).toBe(true);
    expect(isMigratedAssetId({ toString: () => ASSET_ID } as any)).toBe(true);
  });

  it('is false for a 12-byte ticker, a short hex, or a plain string', () => {
    expect(isMigratedAssetId(TICKER_HEX)).toBe(false);
    expect(isMigratedAssetId('0xdead')).toBe(false);
    expect(isMigratedAssetId('PSRF')).toBe(false);
  });
});

describe('getAssetId', () => {
  it('returns a 16-byte asset id unchanged on a 7.x block', async () => {
    expect(await getAssetId(ASSET_ID, block(7_000_003))).toBe(ASSET_ID);
  });

  it('hashes a legacy ticker on a pre-7.x block', async () => {
    // "PSRF" was created pre-v7 as a ticker; the chain migration derives its asset id
    // deterministically, and `getAssetIdForLegacyTicker` reproduces that — it is ASSET_ID.
    expect(await getAssetId('PSRF', block(6_003_040))).toBe(
      await getAssetIdForLegacyTicker('PSRF')
    );
    expect(await getAssetId('PSRF', block(6_003_040))).toBe(ASSET_ID);
  });

  it('returns a 16-byte asset id unchanged even when the block reports a stale pre-7.x spec', async () => {
    // the regression: v7.0.0 was live and the event already carried the 16-byte asset id, but
    // @subql/node still reported spec 6003050 — the old code re-hashed ASSET_ID into a bogus id
    expect(await getAssetId(ASSET_ID, block(6_003_050))).toBe(ASSET_ID);
    expect(await getAssetId({ toString: () => ASSET_ID } as any, block(6_003_050))).toBe(ASSET_ID);
  });
});
