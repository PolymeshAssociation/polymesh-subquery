import { LAST_V4, V5 } from './consts';
import { registerShape, stable } from './registry';

/**
 * `treasury` pallet parameter shapes. `TreasuryDisbursement` gained the target's primary key at
 * 5.0.0.
 */
registerShape('treasury', 'TreasuryDisbursement', [
  { from: 0, to: LAST_V4, fields: ['treasuryDid', 'targetDid', 'amount'] },
  { from: V5, fields: ['treasuryDid', 'targetDid', 'targetPrimaryKey', 'amount'] },
]);
registerShape(
  'treasury',
  'TreasuryDisbursementFailed',
  stable(['treasuryDid', 'targetDid', 'targetPrimaryKey', 'amount'])
);
registerShape('treasury', 'TreasuryReimbursement', stable(['sourceDid', 'amount']));
