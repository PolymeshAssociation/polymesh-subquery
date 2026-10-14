import { LAST_V4 } from './consts';
import { discontinuedAt, registerShape, stable } from './registry';

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

/**
 * The transfer-manager events, replaced by the stat-type events at 5.0.0. Their asset was a
 * `Ticker`, keyed `ticker`.
 */
const transferManager = ['callerDid', 'ticker', 'transferManager'];

registerShape('statistics', 'TransferManagerAdded', discontinuedAt(LAST_V4, transferManager));
registerShape('statistics', 'TransferManagerRemoved', discontinuedAt(LAST_V4, transferManager));
registerShape(
  'statistics',
  'ExemptionsAdded',
  discontinuedAt(LAST_V4, [...transferManager, 'scopeIds'])
);
registerShape(
  'statistics',
  'ExemptionsRemoved',
  discontinuedAt(LAST_V4, [...transferManager, 'scopeIds'])
);
