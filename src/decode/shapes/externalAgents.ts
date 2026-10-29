import { registerShape, stable, tickerBeforeV7 } from './registry';

/**
 * `externalAgents` pallet parameter shapes.
 *
 * Stable v5.4.3 through v8.0.0 in both arity and position; the only change across that span is
 * `Ticker` becoming `AssetId` at 7.x, which `getAssetId` already handles.
 */
registerShape(
  'externalAgents',
  'GroupCreated',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'agId', 'permissions']))
);
registerShape(
  'externalAgents',
  'GroupPermissionsUpdated',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'agId', 'permissions']))
);
registerShape(
  'externalAgents',
  'AgentAdded',
  tickerBeforeV7(stable(['agentDid', 'assetId', 'group']))
);
registerShape(
  'externalAgents',
  'AgentRemoved',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'agentDid']))
);
registerShape(
  'externalAgents',
  'GroupChanged',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'agentDid', 'group']))
);
