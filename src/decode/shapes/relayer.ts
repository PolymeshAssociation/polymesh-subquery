import { LAST_V7, V8 } from './consts';
import { discontinuedAt, introducedAt, registerShape, registerShapes } from './registry';

/**
 * `relayer` pallet parameter shapes.
 *
 * The pallet was renamed paying-key → subsidy at a clean v8.0.0 boundary (verified against
 * `pallets/relayer/src/lib.rs` at v6.3.0, v7.0.0, v7.4.0, v8.0.0): pre-v8 events carry a leading
 * `EventDid` that the v8 events drop. Renamed events don't collide positionally — each name keeps
 * its own shape — so only `UpdatedPolyxLimit`, whose name is unchanged, needs a two-entry shape.
 * Fields are named so one handler can read either era: pre-v8 `AuthorizedPayingKey` and v8+
 * `ApprovedSubsidy` both expose `initialPolyxLimit`. Where that shared name is not the runtime's own,
 * the runtime's is kept — the table is the record of what an event looks like, so a convenient
 * rename here would make it a record of something else. Verified against testnet metadata at
 * spec 8001020.
 */
registerShape(
  'relayer',
  'AuthorizedPayingKey',
  discontinuedAt(LAST_V7, ['did', 'userKey', 'payingKey', 'initialPolyxLimit', 'authId'])
);
registerShape(
  'relayer',
  'AcceptedPayingKey',
  discontinuedAt(LAST_V7, ['did', 'userKey', 'payingKey'])
);
registerShape(
  'relayer',
  'RemovedPayingKey',
  discontinuedAt(LAST_V7, ['did', 'userKey', 'payingKey'])
);
registerShape('relayer', 'UpdatedPolyxLimit', [
  { from: 0, to: LAST_V7, fields: ['did', 'userKey', 'payingKey', 'remaining', 'oldRemaining'] },
  { from: V8, fields: ['userKey', 'payingKey', 'remaining', 'oldRemaining'] },
]);

registerShapes(
  'relayer',
  ['ApprovedSubsidy', 'AcceptedSubsidy', 'RemovedPendingSubsidy'],
  introducedAt(V8, ['userKey', 'payingKey', 'initialPolyxLimit'])
);
/** The allowance left when the subsidy ended, not an amount drawn. */
registerShape(
  'relayer',
  'RemovedSubsidy',
  introducedAt(V8, ['userKey', 'payingKey', 'remaining'])
);
registerShape(
  'relayer',
  'SubsidyDebited',
  introducedAt(V8, ['userKey', 'payingKey', 'amount'])
);
