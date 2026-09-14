import { LAST_V5, V6 } from './consts';
import { registerShape, stable } from './registry';

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
registerShape(
  'corporateaction',
  'CAInitiated',
  stable(['did', 'caId', 'corporateAction', 'details'])
);
registerShape('corporateaction', 'CARemoved', stable(['did', 'caId']));
registerShape('corporateaction', 'RecordDateChanged', stable(['did', 'caId', 'corporateAction']));
registerShape('corporateaction', 'CALinkedToDoc', stable(['did', 'caId', 'docIds']));
registerShape(
  'corporateaction',
  'DefaultTargetIdentitiesChanged',
  stable(['did', 'assetId', 'targets'])
);
registerShape('corporateaction', 'DefaultWithholdingTaxChanged', stable(['did', 'assetId', 'tax']));
registerShape(
  'corporateaction',
  'DidWithholdingTaxChanged',
  stable(['did', 'assetId', 'targetDid', 'tax'])
);
registerShape('corporateaction', 'MaxDetailsLengthChanged', stable(['did', 'length']));

registerShape(
  'checkpoint',
  'CheckpointCreated',
  stable(['did', 'assetId', 'checkpointId', 'totalSupply', 'moment'])
);
registerShape('checkpoint', 'MaximumSchedulesComplexityChanged', stable(['did', 'complexity']));
registerShape('checkpoint', 'ScheduleCreated', [
  { from: 0, to: LAST_V5, fields: ['did', 'assetId', 'storedSchedule'] },
  { from: V6, fields: ['did', 'assetId', 'scheduleId', 'scheduleCheckpoints'] },
]);
registerShape('checkpoint', 'ScheduleRemoved', [
  { from: 0, to: LAST_V5, fields: ['did', 'assetId', 'storedSchedule'] },
  { from: V6, fields: ['did', 'assetId', 'scheduleId', 'scheduleCheckpoints'] },
]);

registerShape('corporateballot', 'Created', stable(['did', 'caId', 'range', 'meta', 'rcv']));
registerShape('corporateballot', 'MetaChanged', stable(['did', 'caId', 'meta']));
registerShape('corporateballot', 'RangeChanged', stable(['did', 'caId', 'range']));
registerShape('corporateballot', 'RCVChanged', stable(['did', 'caId', 'rcv']));
registerShape('corporateballot', 'Removed', stable(['did', 'caId']));
registerShape('corporateballot', 'VoteCast', stable(['did', 'caId', 'votes']));
