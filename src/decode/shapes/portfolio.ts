import { LAST_V5 } from './consts';
import { discontinuedAt, registerShape } from './registry';

/**
 * `portfolio` pallet parameter shapes.
 *
 * `FungibleTokensMovedBetweenPortfolios` and `NFTsMovedBetweenPortfolios` were declared and
 * emitted only at v5.4.3, in `unchecked_move_funds`, and removed at v6.0.0 (defect A8). They are
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
