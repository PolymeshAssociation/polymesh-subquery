import { Codec } from '@polkadot/types/types';
import { getAssetIdForLegacyTicker } from '../../utils/assets';
import { isObject } from '../../utils/codec';
import { ChainSnapshot } from '../snapshot';

/**
 * The index's asset id for a storage key's asset argument: an asset id from 7.0, and before it a
 * ticker, or a statistics scope over one, whose asset id is derived as the handlers derive it.
 */
export const assetIdOf = async (arg: Codec): Promise<string> => {
  const json: unknown = arg.toJSON();
  if (isObject(json) && typeof json.ticker === 'string') {
    return getAssetIdForLegacyTicker(json.ticker);
  }
  const key = arg.toString();
  // a ticker is 12 bytes, an asset id 16
  return key.length === 26 ? getAssetIdForLegacyTicker(key) : key;
};

/** What each identity holds of each asset: units (`asset.balanceOf`) and tokens (`nft.numberOfNFTs`) */
export interface IdentityHolding {
  amount: bigint;
  nftCount: number;
}

/** asset id → identity → what it holds, from the two per-identity totals the chain keeps */
export const identityHoldings = (
  snap: ChainSnapshot
): Promise<ReadonlyMap<string, ReadonlyMap<string, IdentityHolding>>> =>
  snap.derive('identityHoldings', async () => {
    const holdings = new Map<string, Map<string, IdentityHolding>>();
    const holdingOf = (assetId: string, did: string): IdentityHolding => {
      const byIdentity = holdings.get(assetId) ?? new Map<string, IdentityHolding>();
      holdings.set(assetId, byIdentity);
      const holding = byIdentity.get(did) ?? { amount: BigInt(0), nftCount: 0 };
      byIdentity.set(did, holding);
      return holding;
    };
    for await (const page of snap.pages('asset.balanceOf')) {
      const pageAssetIds = await Promise.all(page.map(({ args }) => assetIdOf(args[0])));
      page.forEach(({ args, value }, i) => {
        holdingOf(pageAssetIds[i], args[1].toString()).amount = BigInt(value?.toString() ?? 0);
      });
    }
    for await (const page of snap.pages('nft.numberOfNFTs')) {
      const pageAssetIds = await Promise.all(page.map(({ args }) => assetIdOf(args[0])));
      page.forEach(({ args, value }, i) => {
        holdingOf(pageAssetIds[i], args[1].toString()).nftCount = Number(value?.toString() ?? 0);
      });
    }
    return holdings;
  });

/** Every asset's id: from `asset.assets` from 7.0, before it derived from `asset.tokens`' tickers */
export const assetIds = (snap: ChainSnapshot): Promise<ReadonlySet<string>> =>
  snap.derive('assetIds', async () => {
    const ids = new Set<string>();
    const item = snap.has('asset.assets') ? 'asset.assets' : 'asset.tokens';
    for await (const page of snap.pages(item)) {
      (await Promise.all(page.map(({ args }) => assetIdOf(args[0])))).forEach(id => ids.add(id));
    }
    return ids;
  });
