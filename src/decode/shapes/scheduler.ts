import { LAST_V4 } from './consts';
import { discontinuedAt, registerShape } from './registry';

/**
 * `scheduler` pallet parameter shapes for the runtimes whose metadata predates named event fields
 * (before 5.0.0), with the names later runtimes give the same fields.
 */
registerShape('scheduler', 'Dispatched', discontinuedAt(LAST_V4, ['task', 'id', 'result']));
