import { LAST_V5, V6 } from './consts';
import { discontinuedAt, registerShape, stable } from './registry';

/**
 * `asset` pallet parameter shapes.
 *
 * v6.0.0 replaced `Transfer` / `Issued` / `Redeemed` with a single `AssetBalanceUpdated`
 * carrying a reason, so those three are registered only for the v5 era and stop there. The v8
 * changes to `AssetBalanceUpdated` were to its parameter *types*, not its arity, and the
 * handler already branches on them.
 */
registerShape('asset', 'AssetCreated', [
  {
    from: V6,
    fields: [
      'did',
      'assetId',
      'divisible',
      'assetType',
      'ownerDid',
      'name',
      'identifiers',
      'fundingRound',
    ],
  },
  {
    // `disableIu` was dropped at 6.0.0; name, identifiers and funding round only arrived at
    // 5.1.0, and the handler falls back to chain storage when they are absent
    from: 0,
    to: LAST_V5,
    fields: [
      'did',
      'assetId',
      'divisible',
      'assetType',
      'ownerDid',
      'disableIu',
      'name',
      'identifiers',
      'fundingRound',
    ],
    optionalFrom: 6,
  },
]);

registerShape('asset', 'AssetRenamed', stable(['did', 'assetId', 'name']));
registerShape('asset', 'FundingRoundSet', stable(['did', 'assetId', 'fundingRound']));
registerShape('asset', 'DocumentAdded', stable(['did', 'assetId', 'documentId', 'document']));
registerShape('asset', 'DocumentRemoved', stable(['did', 'assetId', 'documentId']));
registerShape('asset', 'IdentifiersUpdated', stable(['did', 'assetId', 'identifiers']));
registerShape('asset', 'DivisibilityChanged', stable(['did', 'assetId', 'divisible']));
registerShape('asset', 'AssetFrozen', stable(['did', 'assetId']));
registerShape('asset', 'AssetUnfrozen', stable(['did', 'assetId']));
registerShape('asset', 'AssetOwnershipTransferred', stable(['did', 'assetId', 'previousOwnerDid']));
registerShape('asset', 'AssetMediatorsAdded', stable(['did', 'assetId', 'mediators']));
registerShape('asset', 'AssetMediatorsRemoved', stable(['did', 'assetId', 'mediators']));
registerShape('asset', 'PreApprovedAsset', stable(['did', 'assetId']));
registerShape('asset', 'RemovePreApprovedAsset', stable(['did', 'assetId']));

registerShape('asset', 'AssetBalanceUpdated', [
  {
    from: V6,
    fields: ['did', 'assetId', 'amount', 'fromHolder', 'toHolder', 'updateReason'],
  },
]);

registerShape(
  'asset',
  'Transfer',
  discontinuedAt(LAST_V5, ['did', 'assetId', 'fromHolder', 'toHolder', 'amount'])
);
registerShape(
  'asset',
  'Issued',
  discontinuedAt(LAST_V5, [
    'did',
    'assetId',
    'beneficiaryDid',
    'amount',
    'fundingRound',
    'totalFundingAmount',
  ])
);
registerShape(
  'asset',
  'Redeemed',
  discontinuedAt(LAST_V5, ['did', 'assetId', 'beneficiaryDid', 'amount'])
);

registerShape('asset', 'TickerRegistered', stable(['did', 'ticker', 'expiry']));
// Deprecated at 6.0.0
registerShape('asset', 'ClassicTickerClaimed', discontinuedAt(LAST_V5, ['did', 'ticker']));
registerShape('asset', 'TickerTransferred', stable(['did', 'ticker', 'previousOwnerDid']));
registerShape('asset', 'TickerLinkedToAsset', stable(['did', 'ticker', 'assetId']));
registerShape('asset', 'TickerUnlinkedFromAsset', stable(['did', 'ticker', 'assetId']));
