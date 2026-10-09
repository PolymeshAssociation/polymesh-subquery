import { LAST_V5, V6 } from './consts';
import { registerShape, stable, tickerBeforeV7 } from './registry';

/**
 * `corporateAction` / `checkpoint` / `corporateBallot` pallet parameter shapes.
 *
 * Walked event-by-event against the Rust source for v5.4.3, v6.3.5, v7.0.0, v7.4.0, v8.0.0
 * (docs/reference/event-shape-verification.md). `CAInitiated` and the `CorporateAction` struct are
 * shape-identical across every one of those tags, as are all six `corporateBallot` events; only
 * `Ticker` → `AssetId` at 7.x, already handled by `getAssetId` / `getCaIdValue`.
 *
 * `ScheduleCreated` / `ScheduleRemoved` are the one real change in this domain: arity 3 → 4 at
 * v6.0.0, `ScheduleId` inserted at index 2 and the payload type changing from `StoredSchedule` to
 * `ScheduleCheckpoints`.
 */
registerShape('corporateaction', 'CAInitiated', stable(['agentDid', 'caId', 'ca', 'details']));
registerShape('corporateaction', 'CARemoved', stable(['agentDid', 'caId']));
registerShape('corporateaction', 'RecordDateChanged', stable(['agentDid', 'caId', 'ca']));
registerShape('corporateaction', 'CALinkedToDoc', stable(['agentDid', 'caId', 'docIds']));
registerShape(
  'corporateaction',
  'DefaultTargetIdentitiesChanged',
  tickerBeforeV7(stable(['agentDid', 'assetId', 'targets']))
);
registerShape(
  'corporateaction',
  'DefaultWithholdingTaxChanged',
  tickerBeforeV7(stable(['agentDid', 'assetId', 'tax']))
);
registerShape(
  'corporateaction',
  'DidWithholdingTaxChanged',
  tickerBeforeV7(stable(['agentDid', 'assetId', 'taxedDid', 'tax']))
);
registerShape('corporateaction', 'MaxDetailsLengthChanged', stable(['callerDid', 'maxLength']));

registerShape(
  'checkpoint',
  'CheckpointCreated',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'checkpointId', 'totalSupply', 'timestamp']))
);
registerShape(
  'checkpoint',
  'MaximumSchedulesComplexityChanged',
  stable(['callerDid', 'maxComplexity'])
);
registerShape(
  'checkpoint',
  'ScheduleCreated',
  tickerBeforeV7([
    { from: 0, to: LAST_V5, fields: ['callerDid', 'assetId', 'storedSchedule'] },
    { from: V6, fields: ['callerDid', 'assetId', 'scheduleId', 'schedule'] },
  ])
);
registerShape(
  'checkpoint',
  'ScheduleRemoved',
  tickerBeforeV7([
    { from: 0, to: LAST_V5, fields: ['callerDid', 'assetId', 'storedSchedule'] },
    { from: V6, fields: ['callerDid', 'assetId', 'scheduleId', 'schedule'] },
  ])
);

registerShape('corporateballot', 'Created', stable(['agentDid', 'caId', 'range', 'meta', 'rcv']));
registerShape('corporateballot', 'MetaChanged', stable(['agentDid', 'caId', 'meta']));
registerShape('corporateballot', 'RangeChanged', stable(['agentDid', 'caId', 'range']));
registerShape('corporateballot', 'RCVChanged', stable(['agentDid', 'caId', 'rcv']));
registerShape('corporateballot', 'Removed', stable(['agentDid', 'caId']));
registerShape('corporateballot', 'VoteCast', stable(['voterDid', 'caId', 'votes']));
