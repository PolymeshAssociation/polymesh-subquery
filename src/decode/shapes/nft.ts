import { LAST_V5, LAST_V7, V8 } from './consts';
import { discontinuedAt, introducedAt, registerShape, stable, tickerBeforeV7 } from './registry';

/**
 * `nft` pallet parameter shapes.
 *
 * Probed against testnet metadata at every major release from the pallet's first appearance. The
 * holdings event was renamed at v8.0.0, from `NFTPortfolioUpdated` to `NFTHoldingsUpdated`, when a
 * holder became an `AssetHolder` — an account or a portfolio — rather than always a portfolio. The
 * arity did not change, so both declare the same fields under v8's names (the chain's, once it names
 * them) and the handler reads one shape across the boundary; `rawAssetHolderToAssetHolder` already
 * reads either holder type.
 *
 * `IssuedNFT` and `RedeemedNFT` are the pre-6.0 issuance and redemption events, before holdings
 * changes were reported through the holdings event. Issuance names the collection rather than the
 * asset. The three approval events added at v8.1.1 name their fields and so decode from the block's
 * own metadata.
 */
registerShape(
  'nft',
  'NFTPortfolioUpdated',
  discontinuedAt(LAST_V7, ['callerDid', 'nfts', 'from', 'to', 'updateReason'])
);

registerShape(
  'nft',
  'NFTHoldingsUpdated',
  introducedAt(V8, ['callerDid', 'nfts', 'from', 'to', 'updateReason'])
);

registerShape(
  'nft',
  'NftCollectionCreated',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'collectionId']))
);

registerShape('nft', 'IssuedNFT', discontinuedAt(LAST_V5, ['did', 'collectionId', 'nftId']));

registerShape('nft', 'RedeemedNFT', discontinuedAt(LAST_V5, ['did', 'ticker', 'nftId']));
