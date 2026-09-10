import { Codec } from '@polkadot/types/types';
import { SEED_EVENT_ID } from '../mappings/consts';
import { Asset, AssetHolder, HolderKind, Holding } from '../types';
import {
  getAssetIdForLegacyTicker,
  getBigIntValue,
  getPortfolioId,
  is7xSpecVersion,
} from '../utils';
import { meshPortfolioToAssetHolder } from '../utils/portfolios';

/**
 * A full storage scan of a double map. `@polkadot`'s `.entries()` type requires the first key
 * for a double map, but passing none is a valid full-prefix scan at runtime.
 */
const scanDoubleMap = (entry: { entries: unknown }): Promise<[{ args: Codec[] }, Codec][]> =>
  (entry.entries as () => Promise<[{ args: Codec[] }, Codec][]>)();

/**
 * Snapshots `portfolio.portfolioAssetBalances` into `Holding` rows at the portfolio grain, plus
 * the `AssetHolder` identity rollup and `Asset.holderCount`.
 *
 * `Holding` is rebuilt from the movement stream, so without an opening snapshot every derived
 * holding is short by whatever a portfolio held at the start block — the same reasoning as
 * `seedAccountBalances` for the POLYX ledger. `genesisHandler` seeds Portfolios but no balances;
 * this fills that gap, and plan [10](../../docs/implementation/10-partial-index.md) reuses the
 * identical read at an arbitrary `START_BLOCK` (`api.query` always targets the block being
 * indexed).
 *
 * Assets whose `Asset` row is not yet indexed are skipped: at genesis there are none, and the
 * partial-index path seeds `Asset` rows before calling this. NFT holdings are seeded separately
 * once the `Nft` entity exists.
 */

export interface SeedContext {
  blockId: string;
  /** unused here, kept for signature parity with `seedAccountBalances` and the plan-10 seeder */
  datetime: Date;
}

export const seedHoldings = async ({ blockId }: SeedContext): Promise<{ seeded: number }> => {
  if (!api.query.portfolio?.portfolioAssetBalances) {
    return { seeded: 0 };
  }

  // Pre-7.x the storage key is a `Ticker`; 7.x+ it is the `AssetId` already.
  const is7x = is7xSpecVersion(api.runtimeVersion.specVersion.toNumber());
  const resolveAssetId = (rawKey: Codec): Promise<string> =>
    is7x ? Promise.resolve(rawKey.toString()) : getAssetIdForLegacyTicker(rawKey.toString());

  const holdings = new Map<string, Holding>();
  const rollups = new Map<string, AssetHolder>();

  const entries = await scanDoubleMap(api.query.portfolio.portfolioAssetBalances);

  for (const [key, rawBalance] of entries) {
    const amount = getBigIntValue(rawBalance);
    if (amount === BigInt(0)) {
      continue;
    }

    const [rawPortfolioId, rawAssetId] = key.args;
    const assetId = await resolveAssetId(rawAssetId);

    if (!(await Asset.get(assetId))) {
      continue;
    }

    const holder = meshPortfolioToAssetHolder(JSON.parse(rawPortfolioId.toString()));
    if ('account' in holder) {
      continue; // account-kind portfolios never carried a balance in this storage
    }
    const { identityId, number } = holder;
    const portfolioId = getPortfolioId({ identityId, number });

    holdings.set(
      `${assetId}/${portfolioId}`,
      Holding.create({
        id: `${assetId}/${portfolioId}`,
        assetId,
        holderKind: HolderKind.Portfolio,
        portfolioId,
        identityId,
        amount,
        nftCount: 0,
        createdEventId: SEED_EVENT_ID,
        updatedEventId: SEED_EVENT_ID,
      })
    );

    const rollupId = `${assetId}/${identityId}`;
    const rollup =
      rollups.get(rollupId) ??
      AssetHolder.create({
        id: rollupId,
        identityId,
        assetId,
        amount: BigInt(0),
        createdEventId: SEED_EVENT_ID,
        updatedEventId: SEED_EVENT_ID,
      });
    rollup.amount += amount;
    rollups.set(rollupId, rollup);
  }

  const holderCounts = new Map<string, number>();
  for (const rollup of rollups.values()) {
    if (rollup.amount > BigInt(0)) {
      holderCounts.set(rollup.assetId, (holderCounts.get(rollup.assetId) ?? 0) + 1);
    }
  }

  const assetUpdates = await Promise.all(
    [...holderCounts].map(async ([assetId, count]) => {
      const asset = await Asset.get(assetId);
      asset.holderCount = count;
      asset.updatedEventId = SEED_EVENT_ID;
      return asset;
    })
  );

  await Promise.all([
    ...[...holdings.values()].map(row => row.save()),
    ...[...rollups.values()].map(row => row.save()),
    ...assetUpdates.map(asset => asset.save()),
  ]);

  logger.info(
    `Seeded ${holdings.size} Holding rows (${rollups.size} AssetHolder rollups) from portfolioAssetBalances at ${blockId}`
  );

  return { seeded: holdings.size };
};
