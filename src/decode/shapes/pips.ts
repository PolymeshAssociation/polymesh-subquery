import { registerShape, stable } from './registry';

/**
 * `pips` pallet parameter shapes. None has changed arity.
 */
registerShape('pips', 'ActivePipLimitChanged', stable(['callerDid', 'oldLimit', 'newLimit']));
registerShape(
  'pips',
  'DefaultEnactmentPeriodChanged',
  stable(['callerDid', 'oldPeriod', 'newPeriod'])
);
registerShape('pips', 'ExecutionCancellingFailed', stable(['pipId']));
registerShape('pips', 'ExecutionScheduled', stable(['callerDid', 'pipId', 'at']));
registerShape('pips', 'ExecutionSchedulingFailed', stable(['callerDid', 'pipId', 'at']));
registerShape('pips', 'ExpiryScheduled', stable(['callerDid', 'pipId', 'at']));
registerShape('pips', 'ExpirySchedulingFailed', stable(['callerDid', 'pipId', 'at']));
registerShape('pips', 'HistoricalPipsPruned', stable(['callerDid', 'oldValue', 'newValue']));
registerShape('pips', 'MaxPipSkipCountChanged', stable(['callerDid', 'oldMax', 'newMax']));
registerShape(
  'pips',
  'MinimumProposalDepositChanged',
  stable(['callerDid', 'oldDeposit', 'newDeposit'])
);
registerShape('pips', 'PendingPipExpiryChanged', stable(['callerDid', 'oldExpiry', 'newExpiry']));
registerShape('pips', 'PipClosed', stable(['callerDid', 'pipId', 'pruned']));
registerShape('pips', 'PipSkipped', stable(['callerDid', 'pipId', 'skippedCount']));
registerShape(
  'pips',
  'ProposalCreated',
  stable([
    'callerDid',
    'proposer',
    'pipId',
    'deposit',
    'url',
    'description',
    'expiry',
    'proposalData',
  ])
);
registerShape('pips', 'ProposalRefund', stable(['callerDid', 'pipId', 'amount']));
registerShape('pips', 'ProposalStateUpdated', stable(['callerDid', 'pipId', 'state']));
registerShape('pips', 'SnapshotCleared', stable(['callerDid', 'snapshotId']));
registerShape(
  'pips',
  'SnapshotResultsEnacted',
  stable(['callerDid', 'snapshotId', 'skipped', 'rejected', 'approved'])
);
registerShape('pips', 'SnapshotTaken', stable(['callerDid', 'snapshotId', 'pips']));
registerShape('pips', 'Voted', stable(['callerDid', 'voter', 'pipId', 'aye', 'deposit']));
