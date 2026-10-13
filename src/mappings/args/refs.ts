import { getAssetIdForLegacyTicker } from '../../utils';
import { RawReference } from './encode';

/** From v7.0 a ticker is a registration that can be linked to any asset; events name the asset. */
export const TICKER_IS_ASSET_BEFORE = 7_000_000;

/**
 * An event's `refs`: each distinct reference as `kind:value`, in the order found, or `undefined`
 * when there are none.
 */
export const toEventRefs = async (
  raw: RawReference[],
  specVersion: number
): Promise<string[] | undefined> => {
  // a ticker named before v7 is filed under the asset id derived from it; from v7 the asset id is
  // an argument of its own
  const resolved = await Promise.all(
    raw.map(async ({ kind, value }): Promise<string | undefined> => {
      if (kind !== 'ticker') {
        return `${kind}:${value}`;
      }
      if (specVersion >= TICKER_IS_ASSET_BEFORE) {
        return undefined;
      }
      return `asset:${await getAssetIdForLegacyTicker(value)}`;
    })
  );

  const refs = [...new Set(resolved.filter((ref): ref is string => ref !== undefined))];

  return refs.length > 0 ? refs : undefined;
};
