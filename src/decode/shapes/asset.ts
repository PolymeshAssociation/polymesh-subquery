import { LAST_V5, V6, V8 } from './consts';
import { discontinuedAt, registerShape, stable, tickerBeforeV7 } from './registry';

/**
 * `asset` pallet parameter shapes.
 *
 * v6.0.0 replaced `Transfer` / `Issued` / `Redeemed` with a single `AssetBalanceUpdated`
 * carrying a reason, so those three are registered only for the v5 era and stop there. The v8
 * changes to `AssetBalanceUpdated` were to its parameter *types*, not its arity, and the
 * handler already branches on them.
 */
registerShape(
  'asset',
  'AssetCreated',
  tickerBeforeV7([
    {
      from: V6,
      fields: [
        'callerDid',
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
        'callerDid',
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
  ])
);

registerShape('asset', 'AssetRenamed', tickerBeforeV7(stable(['callerDid', 'assetId', 'name'])));
registerShape(
  'asset',
  'FundingRoundSet',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'fundingRound']))
);
registerShape(
  'asset',
  'DocumentAdded',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'documentId', 'document']))
);
registerShape(
  'asset',
  'DocumentRemoved',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'documentId']))
);
registerShape(
  'asset',
  'IdentifiersUpdated',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'identifiers']))
);
registerShape(
  'asset',
  'DivisibilityChanged',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'divisible']))
);
registerShape('asset', 'AssetFrozen', tickerBeforeV7(stable(['callerDid', 'assetId'])));
registerShape('asset', 'AssetUnfrozen', tickerBeforeV7(stable(['callerDid', 'assetId'])));
registerShape(
  'asset',
  'AssetOwnershipTransferred',
  tickerBeforeV7(stable(['newOwnerDid', 'assetId', 'oldOwnerDid']))
);
registerShape(
  'asset',
  'AssetMediatorsAdded',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'mediators']))
);
registerShape(
  'asset',
  'AssetMediatorsRemoved',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'mediators']))
);
registerShape('asset', 'PreApprovedAsset', tickerBeforeV7(stable(['callerDid', 'assetId'])));
registerShape('asset', 'RemovePreApprovedAsset', tickerBeforeV7(stable(['callerDid', 'assetId'])));

registerShape(
  'asset',
  'AssetBalanceUpdated',
  tickerBeforeV7([
    {
      from: V6,
      fields: ['callerDid', 'assetId', 'amount', 'from', 'to', 'updateReason'],
    },
  ])
);

registerShape(
  'asset',
  'Transfer',
  tickerBeforeV7(discontinuedAt(LAST_V5, ['did', 'assetId', 'fromHolder', 'toHolder', 'amount']))
);
registerShape(
  'asset',
  'Issued',
  tickerBeforeV7(
    discontinuedAt(LAST_V5, [
      'did',
      'assetId',
      'beneficiaryDid',
      'amount',
      'fundingRound',
      'totalFundingAmount',
    ])
  )
);
registerShape(
  'asset',
  'Redeemed',
  tickerBeforeV7(discontinuedAt(LAST_V5, ['did', 'assetId', 'beneficiaryDid', 'amount']))
);

// v8 account-level asset layer (defect G11). AccountId-keyed, so no `did` parameter.
registerShape('asset', 'Approval', [
  { from: V8, fields: ['owner', 'spender', 'assetId', 'amount'] },
]);
registerShape('asset', 'AllowanceSpent', [
  { from: V8, fields: ['owner', 'spender', 'assetId', 'amountSpent', 'remainingAllowance'] },
]);

// the v8 account-side transfer path — `pendingTransferId` links to an existing Instruction
registerShape('asset', 'CreatedAssetTransfer', [
  { from: V8, fields: ['assetId', 'from', 'to', 'amount', 'memo', 'pendingTransferId'] },
]);

// asset metadata (defect G13) and asset-type events. Arity has been stable across the tags
// walked in docs/reference/event-shape-verification.md; only `Ticker → AssetId` at 7.x, which
// `getAssetId` already absorbs.
registerShape(
  'asset',
  'SetAssetMetadataValue',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'value', 'valueDetail']))
);
registerShape(
  'asset',
  'SetAssetMetadataValueDetails',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'valueDetail']))
);
registerShape(
  'asset',
  'RegisterAssetMetadataLocalType',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'name', 'localKey', 'spec']))
);
registerShape('asset', 'RegisterAssetMetadataGlobalType', stable(['name', 'globalKey', 'spec']));
registerShape(
  'asset',
  'LocalMetadataKeyDeleted',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'localKey']))
);
registerShape(
  'asset',
  'MetadataValueDeleted',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'key']))
);
registerShape('asset', 'GlobalMetadataSpecUpdated', stable(['name', 'spec']));
registerShape(
  'asset',
  'AssetTypeChanged',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'assetType']))
);
registerShape('asset', 'CustomAssetTypeExists', stable(['callerDid', 'customAssetTypeId', 'name']));
registerShape(
  'asset',
  'CustomAssetTypeRegistered',
  stable(['callerDid', 'customAssetTypeId', 'name'])
);

registerShape('asset', 'TickerRegistered', stable(['ownerDid', 'ticker', 'expiry']));
// Deprecated at 6.0.0
registerShape(
  'asset',
  'ClassicTickerClaimed',
  discontinuedAt(LAST_V5, ['did', 'ticker', 'ethereumAddress'])
);
registerShape('asset', 'TickerTransferred', stable(['newOwnerDid', 'ticker', 'oldOwnerDid']));
registerShape('asset', 'TickerLinkedToAsset', stable(['callerDid', 'ticker', 'assetId']));
registerShape('asset', 'TickerUnlinkedFromAsset', stable(['callerDid', 'ticker', 'assetId']));

registerShape('asset', 'AssetAffirmationExemption', tickerBeforeV7(stable(['assetId'])));
registerShape(
  'asset',
  'ControllerTransfer',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'source', 'amount']))
);
registerShape('asset', 'RemoveAssetAffirmationExemption', tickerBeforeV7(stable(['assetId'])));
