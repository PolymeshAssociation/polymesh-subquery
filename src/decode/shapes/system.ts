import { LAST_V4 } from './consts';
import { discontinuedAt, registerShape } from './registry';

/**
 * `system` pallet parameter shapes for the runtimes whose metadata predates named event fields
 * (before 5.0.0). They carry the names every later runtime gives the same fields, so one set of
 * names reads across the change.
 */
registerShape('system', 'ExtrinsicSuccess', discontinuedAt(LAST_V4, ['dispatchInfo']));
registerShape(
  'system',
  'ExtrinsicFailed',
  discontinuedAt(LAST_V4, ['dispatchError', 'dispatchInfo'])
);
registerShape('system', 'NewAccount', discontinuedAt(LAST_V4, ['account']));
