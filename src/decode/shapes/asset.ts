import { LAST_V5, V6 } from './consts';
import { registerShape } from './registry';

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

registerShape('asset', 'AssetRenamed', [{ from: 0, fields: ['did', 'assetId', 'name'] }]);
registerShape('asset', 'FundingRoundSet', [
  { from: 0, fields: ['did', 'assetId', 'fundingRound'] },
]);
registerShape('asset', 'DocumentAdded', [
  { from: 0, fields: ['did', 'assetId', 'documentId', 'document'] },
]);
registerShape('asset', 'DocumentRemoved', [{ from: 0, fields: ['did', 'assetId', 'documentId'] }]);
registerShape('asset', 'IdentifiersUpdated', [
  { from: 0, fields: ['did', 'assetId', 'identifiers'] },
]);
registerShape('asset', 'DivisibilityChanged', [
  { from: 0, fields: ['did', 'assetId', 'divisible'] },
]);
registerShape('asset', 'AssetFrozen', [{ from: 0, fields: ['did', 'assetId'] }]);
registerShape('asset', 'AssetUnfrozen', [{ from: 0, fields: ['did', 'assetId'] }]);
registerShape('asset', 'AssetOwnershipTransferred', [
  { from: 0, fields: ['did', 'assetId', 'previousOwnerDid'] },
]);
registerShape('asset', 'AssetMediatorsAdded', [
  { from: 0, fields: ['did', 'assetId', 'mediators'] },
]);
registerShape('asset', 'AssetMediatorsRemoved', [
  { from: 0, fields: ['did', 'assetId', 'mediators'] },
]);
registerShape('asset', 'PreApprovedAsset', [{ from: 0, fields: ['did', 'assetId'] }]);
registerShape('asset', 'RemovePreApprovedAsset', [{ from: 0, fields: ['did', 'assetId'] }]);

registerShape('asset', 'AssetBalanceUpdated', [
  {
    from: V6,
    fields: ['did', 'assetId', 'amount', 'fromHolder', 'toHolder', 'updateReason'],
  },
]);

registerShape('asset', 'Transfer', [
  { from: 0, to: LAST_V5, fields: ['did', 'assetId', 'fromHolder', 'toHolder', 'amount'] },
]);
registerShape('asset', 'Issued', [
  {
    from: 0,
    to: LAST_V5,
    fields: ['did', 'assetId', 'beneficiaryDid', 'amount', 'fundingRound', 'totalFundingAmount'],
  },
]);
registerShape('asset', 'Redeemed', [
  { from: 0, to: LAST_V5, fields: ['did', 'assetId', 'beneficiaryDid', 'amount'] },
]);

registerShape('asset', 'TickerRegistered', [{ from: 0, fields: ['did', 'ticker', 'expiry'] }]);
// Deprecated at 6.0.0
registerShape('asset', 'ClassicTickerClaimed', [
  { from: 0, to: LAST_V5, fields: ['did', 'ticker'] },
]);
registerShape('asset', 'TickerTransferred', [
  { from: 0, fields: ['did', 'ticker', 'previousOwnerDid'] },
]);
registerShape('asset', 'TickerLinkedToAsset', [{ from: 0, fields: ['did', 'ticker', 'assetId'] }]);
registerShape('asset', 'TickerUnlinkedFromAsset', [
  { from: 0, fields: ['did', 'ticker', 'assetId'] },
]);
