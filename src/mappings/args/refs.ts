import { hexToU8a } from '@polkadot/util';
import { getAssetIdForLegacyTicker } from '../../utils';
import { paddedText } from '../../utils/text';
import { RawReference } from './encode';

/** From v7.0 a ticker is a registration that can be linked to any asset; events name the asset too. */
export const TICKER_IS_ASSET_BEFORE = 7_000_000;

/**
 * An event's `refs`: each distinct reference as `kind:value`, in the order found, or `undefined`
 * when there are none.
 */
export const toEventRefs = async (
  raw: RawReference[],
  specVersion: number
): Promise<string[] | undefined> => {
  // a ticker is filed as itself in every era, and before v7 also under the asset id derived from
  // it, since then the chain named assets by ticker; from v7 an event that names an asset says so
  // in an argument of its own
  const resolved = await Promise.all(
    raw.map(async ({ kind, value }): Promise<string[]> => {
      if (kind !== 'ticker') {
        return [`${kind}:${value}`];
      }
      const ticker = `ticker:${paddedText(hexToU8a(value))}`;
      if (specVersion >= TICKER_IS_ASSET_BEFORE) {
        return [ticker];
      }
      return [`asset:${await getAssetIdForLegacyTicker(value)}`, ticker];
    })
  );

  const refs = [...new Set(resolved.flat())];

  return refs.length > 0 ? refs : undefined;
};
