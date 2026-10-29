import { LAST_V5, LAST_V6 } from './consts';
import { discontinuedAt, registerShape } from './registry';

/**
 * The batch failure events of the runtimes that predate named event fields. A failed batch is
 * told from a successful one by these alone, so they are stored by name rather than by position.
 *
 * The count of events each call deposited comes first, then the failing call as `(index, error)`;
 * `BatchOptimisticFailed` carries a list of those, one per failing call. From 6.0.0 the chain
 * names `BatchInterrupted` as `{ index, error }`, and `BatchInterruptedOld` keeps the earlier
 * layout until the 6.3 line retires it.
 */
registerShape('utility', 'BatchInterrupted', discontinuedAt(LAST_V5, ['eventCounts', 'errorAt']));
registerShape(
  'utility',
  'BatchInterruptedOld',
  discontinuedAt(LAST_V6, ['eventCounts', 'errorAt'])
);
registerShape(
  'utility',
  'BatchOptimisticFailed',
  discontinuedAt(LAST_V6, ['eventCounts', 'errorsAt'])
);
