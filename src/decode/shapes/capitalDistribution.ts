import { registerShape, stable } from './registry';

/**
 * `capitalDistribution` pallet parameter shapes. None has changed arity.
 */
registerShape(
  'capitalDistribution',
  'BenefitClaimed',
  stable(['callerDid', 'holderDid', 'caId', 'distribution', 'benefit', 'tax'])
);
registerShape('capitalDistribution', 'Created', stable(['agentDid', 'caId', 'distribution']));
registerShape('capitalDistribution', 'Reclaimed', stable(['agentDid', 'caId', 'amount']));
registerShape('capitalDistribution', 'Removed', stable(['agentDid', 'caId']));
