import { registerShape, stable } from './registry';

/**
 * `protocolFee` pallet parameter shapes. None has changed arity.
 */
registerShape('protocolFee', 'CoefficientSet', stable(['callerDid', 'coefficient']));
registerShape('protocolFee', 'FeeCharged', stable(['account', 'fee']));
registerShape('protocolFee', 'FeeSet', stable(['callerDid', 'fee']));
