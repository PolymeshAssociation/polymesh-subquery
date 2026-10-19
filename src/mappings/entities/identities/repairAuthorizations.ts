import { AuthorizationStatusEnum } from '../../../types';

/**
 * Chain authorization types whose payloads the asset-id migration rewrote.
 *
 * `TransferTicker` names a ticker in every era and is deliberately excluded; every other variant
 * carries no asset reference at all.
 */
export const AUTHORIZATION_TYPES_MIGRATED_TO_ASSET_IDS = new Set([
  'TransferAssetOwnership',
  'BecomeAgent',
]);

/**
 * A `Ticker` is 12 bytes and an `AssetId` is 16, so within the types above the encoded length says
 * which era a payload belongs to - no guessing at its contents.
 */
const LEGACY_TICKER_HEX = /^0x[0-9a-fA-F]{24}$/;

/**
 * The legacy ticker a payload names, or `undefined` when it already names an asset id.
 *
 * `TransferAssetOwnership` carries the value bare; `BecomeAgent` carries it at the head of a
 * `[ticker, agentGroup]` pair.
 */
export const legacyTickerOf = (data?: string | null): string | undefined => {
  if (!data) {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }

  const value = Array.isArray(parsed) ? parsed[0] : parsed;

  return typeof value === 'string' && LEGACY_TICKER_HEX.test(value) ? value : undefined;
};

/** Rebuilds a payload with `assetId` in place of the ticker, leaving any other members alone */
export const withAssetId = (data: string, assetId: string): string => {
  const parsed = JSON.parse(data);

  return JSON.stringify(Array.isArray(parsed) ? [assetId, ...parsed.slice(1)] : assetId);
};

/**
 * Whether a row still holds the ticker its creation event carried, and so needs the asset id the
 * chain migrated to.
 */
export const needsAssetIdRepair = (row: {
  status: AuthorizationStatusEnum;
  type: string | null;
  data?: string | null;
}): boolean =>
  AUTHORIZATION_TYPES_MIGRATED_TO_ASSET_IDS.has(row.type) &&
  row.status === AuthorizationStatusEnum.Pending &&
  legacyTickerOf(row.data) !== undefined;
