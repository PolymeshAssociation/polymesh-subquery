import { LAST_V5 } from './consts';
import { discontinuedAt, registerShape, stable, tickerBeforeV7 } from './registry';

/**
 * `portfolio` pallet parameter shapes.
 *
 * `FungibleTokensMovedBetweenPortfolios` and `NFTsMovedBetweenPortfolios` were declared and
 * emitted only at v5.4.3, in `unchecked_move_funds`, and removed at v6.0.0. They are
 * exclusive branches of a `match` and `MovedBetweenPortfolios` is not emitted alongside them, so
 * a v5-era movement routed through `unchecked_move_funds` is otherwise absent from the index.
 * Different arities (6 vs 5), so each needs its own entry.
 */
registerShape(
  'portfolio',
  'FungibleTokensMovedBetweenPortfolios',
  discontinuedAt(LAST_V5, ['did', 'fromPortfolio', 'toPortfolio', 'ticker', 'amount', 'memo'])
);

registerShape(
  'portfolio',
  'NFTsMovedBetweenPortfolios',
  discontinuedAt(LAST_V5, ['did', 'fromPortfolio', 'toPortfolio', 'nfts', 'memo'])
);

registerShape('portfolio', 'AllowIdentityToCreatePortfolios', stable(['callerDid', 'allowedDid']));
registerShape(
  'portfolio',
  'FundsMovedBetweenPortfolios',
  stable(['callerDid', 'from', 'to', 'fund', 'memo'])
);
registerShape('portfolio', 'PortfolioCreated', stable(['callerDid', 'portfolioNumber', 'name']));
registerShape(
  'portfolio',
  'PortfolioCustodianChanged',
  stable(['callerDid', 'portfolioId', 'custodianDid'])
);
registerShape('portfolio', 'PortfolioDeleted', stable(['callerDid', 'portfolioNumber']));
registerShape('portfolio', 'PortfolioRenamed', stable(['callerDid', 'portfolioNumber', 'name']));
registerShape(
  'portfolio',
  'PreApprovedPortfolio',
  tickerBeforeV7(stable(['callerDid', 'portfolioId', 'assetId']))
);
registerShape('portfolio', 'RevokeCreatePortfoliosPermission', stable(['callerDid', 'revokedDid']));
registerShape(
  'portfolio',
  'RevokePreApprovedPortfolio',
  tickerBeforeV7(stable(['callerDid', 'portfolioId', 'assetId']))
);
registerShape('portfolio', 'UserPortfolios', stable(['did', 'portfolios']));
