import { registerShape } from './registry';

/**
 * `externalAgents` pallet parameter shapes.
 *
 * Stable v5.4.3 through v8.0.0 in both arity and position; the only change across that span is
 * `Ticker` becoming `AssetId` at 7.x, which `getAssetId` already handles.
 */
registerShape('externalAgents', 'GroupCreated', [
  { from: 0, fields: ['did', 'assetId', 'agId', 'permissions'] },
]);
registerShape('externalAgents', 'GroupPermissionsUpdated', [
  { from: 0, fields: ['did', 'assetId', 'agId', 'permissions'] },
]);
registerShape('externalAgents', 'AgentAdded', [
  { from: 0, fields: ['did', 'assetId', 'agentGroup'] },
]);
registerShape('externalAgents', 'AgentRemoved', [
  { from: 0, fields: ['did', 'assetId', 'agentDid'] },
]);
registerShape('externalAgents', 'GroupChanged', [
  { from: 0, fields: ['did', 'assetId', 'agentDid', 'agentGroup'] },
]);
