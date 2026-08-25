import { SubstrateBlock } from '@subql/types';
import { Authorization, AuthorizationStatusEnum } from '../../../types';
import { getAssetIdForLegacyTicker, getPaginatedData, is7xChain, padId } from '../../../utils';

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

/**
 * Repairs `authorizations.data` rows indexed before the chain migrated stored authorization
 * payloads from tickers to asset ids.
 *
 * The chain's v6 to v7 `ticker_migrations` rewrote each payload with `AssetId::from(ticker)`, which
 * is `blake2_128(("legacy_ticker", ticker))` normalised to a v8 UUID. That is reproducible from the
 * ticker already stored here, so the repair derives the asset id locally rather than reading
 * `identity.authorizations` back off the chain.
 *
 * Runs on transaction-version bumps of 7.x and later, and is idempotent - a repaired row no longer
 * holds a 12 byte payload, so it is not a candidate on the next pass.
 */
export const repairAuthorizationsAfterUpgrade = async (block: SubstrateBlock): Promise<void> => {
  if (!is7xChain(block)) {
    logger.info('Authorization payload repair skipped: chain predates asset-id payloads');

    return;
  }

  const blockId = padId(block.block.header.number.toString());

  const pending = await getPaginatedData<Authorization, 'status'>(
    'Authorization',
    'status',
    AuthorizationStatusEnum.Pending
  );

  const stale = pending.filter(needsAssetIdRepair);

  logger.info(`Authorization payload repair found ${stale.length} rows still naming a ticker`);

  const repaired: Authorization[] = [];
  let failed = 0;

  for (const row of stale) {
    try {
      const assetId = await getAssetIdForLegacyTicker(legacyTickerOf(row.data));

      row.data = withAssetId(row.data, assetId);
      row.updatedBlockId = blockId;
      repaired.push(row);
    } catch (e) {
      failed += 1;
      logger.warn(`Failed repairing authorization ${row.id} at block ${blockId}: ${e}`);
    }
  }

  if (repaired.length) {
    await store.bulkUpdate('Authorization', repaired);
  }

  logger.info(
    `Authorization payload repair rewrote ${repaired.length} rows` +
      (failed ? `, failed ${failed}` : '')
  );
};
