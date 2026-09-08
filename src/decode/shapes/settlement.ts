import { LAST_V7 } from './consts';
import { discontinuedAt, registerShape, stable } from './registry';

/**
 * `settlement` pallet parameter shapes.
 *
 * `InstructionCreated` kept its arity across 6.0.0; what changed was the encoding of its `legs`
 * parameter, which gained NFT and off-chain variants. That branch stays in the handler because
 * it is a payload change, not a positional one.
 */
registerShape('settlement', 'VenueCreated', stable(['did', 'venueId', 'details', 'venueType']));
registerShape('settlement', 'VenueDetailsUpdated', stable(['did', 'venueId', 'details']));
registerShape('settlement', 'VenueTypeUpdated', stable(['did', 'venueId', 'venueType']));
registerShape(
  'settlement',
  'VenueSignersUpdated',
  stable(['did', 'venueId', 'signers', 'updateType'])
);

registerShape(
  'settlement',
  'InstructionCreated',
  stable([
    'did',
    'venueId',
    'instructionId',
    'settlementType',
    'tradeDate',
    'valueDate',
    'legs',
    'memo',
  ])
);

const portfolioAffirmation = ['did', 'portfolio', 'instructionId'];

registerShape('settlement', 'InstructionAffirmed', stable(portfolioAffirmation));
// `InstructionAuthorized` and `InstructionUnauthorized` are absent from the v8 runtime
registerShape('settlement', 'InstructionAuthorized', discontinuedAt(LAST_V7, portfolioAffirmation));
registerShape(
  'settlement',
  'InstructionUnauthorized',
  discontinuedAt(LAST_V7, portfolioAffirmation)
);
registerShape('settlement', 'AffirmationWithdrawn', stable(portfolioAffirmation));
registerShape('settlement', 'InstructionAutomaticallyAffirmed', stable(portfolioAffirmation));

const identityAndInstruction = ['did', 'instructionId'];

registerShape('settlement', 'InstructionRejected', stable(identityAndInstruction));
registerShape('settlement', 'InstructionExecuted', stable(identityAndInstruction));
// Absent from the v8 runtime; `FailedToExecuteInstruction` is what reports a failure there
registerShape('settlement', 'InstructionFailed', discontinuedAt(LAST_V7, identityAndInstruction));
registerShape('settlement', 'InstructionLocked', stable(identityAndInstruction));
registerShape('settlement', 'InstructionUnlocked', stable(identityAndInstruction));
registerShape('settlement', 'SettlementManuallyExecuted', stable(identityAndInstruction));
registerShape('settlement', 'MediatorAffirmationWithdrawn', stable(identityAndInstruction));

registerShape('settlement', 'FailedToExecuteInstruction', stable(['instructionId', 'error']));
registerShape(
  'settlement',
  'MediatorAffirmationReceived',
  stable(['did', 'instructionId', 'expiry'])
);
registerShape('settlement', 'InstructionMediators', stable(['instructionId', 'mediators']));
registerShape(
  'settlement',
  'ReceiptClaimed',
  stable(['did', 'instructionId', 'legId', 'receiptUid', 'signer', 'metadata'])
);
registerShape('settlement', 'FundsTransferred', stable(['did', 'fromHolder', 'toHolder', 'fund']));
