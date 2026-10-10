import { registerShape, stable } from './registry';

/**
 * `statistics` pallet parameter shapes. None has changed arity; the asset was an `AssetScope`
 * before 7.0.0 and is named `assetId` in every era.
 */
registerShape(
  'statistics',
  'AssetStatsUpdated',
  stable(['callerDid', 'assetId', 'statType', 'updates'])
);
registerShape(
  'statistics',
  'SetAssetTransferCompliance',
  stable(['callerDid', 'assetId', 'transferConditions'])
);
registerShape('statistics', 'StatTypesAdded', stable(['callerDid', 'assetId', 'statTypes']));
registerShape('statistics', 'StatTypesRemoved', stable(['callerDid', 'assetId', 'statTypes']));
registerShape(
  'statistics',
  'TransferConditionExemptionsAdded',
  stable(['callerDid', 'exemptKey', 'entities'])
);
registerShape(
  'statistics',
  'TransferConditionExemptionsRemoved',
  stable(['callerDid', 'exemptKey', 'entities'])
);
