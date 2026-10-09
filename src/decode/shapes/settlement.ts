import { LAST_V7 } from './consts';
import { discontinuedAt, registerShape, stable, tickerBeforeV7 } from './registry';

/**
 * `settlement` pallet parameter shapes.
 *
 * `InstructionCreated` kept its arity across 6.0.0; what changed was the encoding of its `legs`
 * parameter, which gained NFT and off-chain variants. That branch stays in the handler because
 * it is a payload change, not a positional one.
 */
registerShape(
  'settlement',
  'VenueCreated',
  stable(['callerDid', 'venueId', 'details', 'venueType'])
);
registerShape('settlement', 'VenueDetailsUpdated', stable(['callerDid', 'venueId', 'details']));
registerShape('settlement', 'VenueTypeUpdated', stable(['callerDid', 'venueId', 'venueType']));
registerShape(
  'settlement',
  'VenueSignersUpdated',
  stable(['callerDid', 'venueId', 'signers', 'added'])
);

registerShape('settlement', 'InstructionCreated', [
  {
    from: 0,
    fields: [
      'callerDid',
      'venueId',
      'instructionId',
      'settlementType',
      'tradeDate',
      'valueDate',
      'legs',
      'memo',
    ],
    // `memo` was added after the v3.x era; early testnet/mainnet blocks emit 7 params.
    optionalFrom: 7,
  },
]);

const portfolioAffirmation = ['callerDid', 'holder', 'instructionId'];

registerShape('settlement', 'InstructionAffirmed', stable(portfolioAffirmation));
// `InstructionAuthorized` / `InstructionUnauthorized` were renamed to the affirmation events before
// v2.3.0, and both public chains start at spec 3000 — no supported runtime ever emits them, so
// neither is declared or registered.
registerShape('settlement', 'AffirmationWithdrawn', stable(portfolioAffirmation));
registerShape('settlement', 'InstructionAutomaticallyAffirmed', stable(portfolioAffirmation));

const identityAndInstruction = ['callerDid', 'instructionId'];

registerShape('settlement', 'InstructionRejected', stable(identityAndInstruction));
registerShape('settlement', 'InstructionExecuted', stable(identityAndInstruction));
// Absent from the v8 runtime; `FailedToExecuteInstruction` is what reports a failure there
registerShape('settlement', 'InstructionFailed', discontinuedAt(LAST_V7, identityAndInstruction));
registerShape('settlement', 'InstructionLocked', stable(identityAndInstruction));
registerShape('settlement', 'InstructionUnlocked', stable(identityAndInstruction));
registerShape('settlement', 'SettlementManuallyExecuted', stable(identityAndInstruction));
registerShape(
  'settlement',
  'MediatorAffirmationWithdrawn',
  stable(['mediatorDid', 'instructionId'])
);

registerShape('settlement', 'FailedToExecuteInstruction', stable(['instructionId', 'error']));
registerShape(
  'settlement',
  'MediatorAffirmationReceived',
  stable(['mediatorDid', 'instructionId', 'expiry'])
);
registerShape('settlement', 'InstructionMediators', stable(['instructionId', 'mediators']));
registerShape(
  'settlement',
  'ReceiptClaimed',
  stable(['callerDid', 'instructionId', 'legId', 'receiptUid', 'signer', 'metadata'])
);
registerShape('settlement', 'FundsTransferred', stable(['callerDid', 'from', 'to', 'fund']));

registerShape('settlement', 'LegFailedExecution', stable(['callerDid', 'instructionId', 'legId']));
registerShape(
  'settlement',
  'MandatoryReceiverAffirmationSet',
  stable(['callerDid', 'requirement'])
);
registerShape(
  'settlement',
  'VenueFiltering',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'enabled']))
);
registerShape(
  'settlement',
  'VenueUnauthorized',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'venueId']))
);
registerShape(
  'settlement',
  'VenuesAllowed',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'venueIds']))
);
registerShape(
  'settlement',
  'VenuesBlocked',
  tickerBeforeV7(stable(['callerDid', 'assetId', 'venueIds']))
);
