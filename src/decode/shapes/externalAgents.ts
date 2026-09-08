import { registerShape, stable } from './registry';

/**
 * `externalAgents` pallet parameter shapes.
 *
 * Stable v5.4.3 through v8.0.0 in both arity and position; the only change across that span is
 * `Ticker` becoming `AssetId` at 7.x, which `getAssetId` already handles.
 */
registerShape('externalAgents', 'GroupCreated', stable(['did', 'assetId', 'agId', 'permissions']));
registerShape(
  'externalAgents',
  'GroupPermissionsUpdated',
  stable(['did', 'assetId', 'agId', 'permissions'])
);
registerShape('externalAgents', 'AgentAdded', stable(['did', 'assetId', 'agentGroup']));
registerShape('externalAgents', 'AgentRemoved', stable(['did', 'assetId', 'agentDid']));
registerShape(
  'externalAgents',
  'GroupChanged',
  stable(['did', 'assetId', 'agentDid', 'agentGroup'])
);
