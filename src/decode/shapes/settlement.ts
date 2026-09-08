import { LAST_V7 } from './consts';
import { registerShape } from './registry';

/**
 * `settlement` pallet parameter shapes.
 *
 * `InstructionCreated` kept its arity across 6.0.0; what changed was the encoding of its `legs`
 * parameter, which gained NFT and off-chain variants. That branch stays in the handler because
 * it is a payload change, not a positional one.
 */
registerShape('settlement', 'VenueCreated', [
  { from: 0, fields: ['did', 'venueId', 'details', 'venueType'] },
]);
registerShape('settlement', 'VenueDetailsUpdated', [
  { from: 0, fields: ['did', 'venueId', 'details'] },
]);
registerShape('settlement', 'VenueTypeUpdated', [
  { from: 0, fields: ['did', 'venueId', 'venueType'] },
]);
registerShape('settlement', 'VenueSignersUpdated', [
  { from: 0, fields: ['did', 'venueId', 'signers', 'updateType'] },
]);

registerShape('settlement', 'InstructionCreated', [
  {
    from: 0,
    fields: [
      'did',
      'venueId',
      'instructionId',
      'settlementType',
      'tradeDate',
      'valueDate',
      'legs',
      'memo',
    ],
  },
]);

const portfolioAffirmation = ['did', 'portfolio', 'instructionId'];

registerShape('settlement', 'InstructionAffirmed', [{ from: 0, fields: portfolioAffirmation }]);
// `InstructionAuthorized` and `InstructionUnauthorized` are absent from the v8 runtime
registerShape('settlement', 'InstructionAuthorized', [
  { from: 0, to: LAST_V7, fields: portfolioAffirmation },
]);
registerShape('settlement', 'InstructionUnauthorized', [
  { from: 0, to: LAST_V7, fields: portfolioAffirmation },
]);
registerShape('settlement', 'AffirmationWithdrawn', [{ from: 0, fields: portfolioAffirmation }]);
registerShape('settlement', 'InstructionAutomaticallyAffirmed', [
  { from: 0, fields: portfolioAffirmation },
]);

const identityAndInstruction = ['did', 'instructionId'];

registerShape('settlement', 'InstructionRejected', [{ from: 0, fields: identityAndInstruction }]);
registerShape('settlement', 'InstructionExecuted', [{ from: 0, fields: identityAndInstruction }]);
// Absent from the v8 runtime; `FailedToExecuteInstruction` is what reports a failure there
registerShape('settlement', 'InstructionFailed', [
  { from: 0, to: LAST_V7, fields: identityAndInstruction },
]);
registerShape('settlement', 'InstructionLocked', [{ from: 0, fields: identityAndInstruction }]);
registerShape('settlement', 'InstructionUnlocked', [{ from: 0, fields: identityAndInstruction }]);
registerShape('settlement', 'SettlementManuallyExecuted', [
  { from: 0, fields: identityAndInstruction },
]);
registerShape('settlement', 'MediatorAffirmationWithdrawn', [
  { from: 0, fields: identityAndInstruction },
]);

registerShape('settlement', 'FailedToExecuteInstruction', [
  { from: 0, fields: ['instructionId', 'error'] },
]);
registerShape('settlement', 'MediatorAffirmationReceived', [
  { from: 0, fields: ['did', 'instructionId', 'expiry'] },
]);
registerShape('settlement', 'InstructionMediators', [
  { from: 0, fields: ['instructionId', 'mediators'] },
]);
registerShape('settlement', 'ReceiptClaimed', [
  {
    from: 0,
    fields: ['did', 'instructionId', 'legId', 'receiptUid', 'signer', 'metadata'],
  },
]);
registerShape('settlement', 'FundsTransferred', [
  { from: 0, fields: ['did', 'fromHolder', 'toHolder', 'fund'] },
]);
