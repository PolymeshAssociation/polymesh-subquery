import { LAST_V7 } from './consts';
import { discontinuedAt, registerShape } from './registry';

/**
 * `staking` pallet parameter shapes for the pre-v8 (Polymesh custom staking pallet) tuple events.
 *
 * v8.0.0 deleted the custom pallet and moved to upstream Substrate staking, whose events are
 * struct-style and decode from block metadata directly. So every shape here closes at the last
 * 7.x spec version.
 *
 * `Bonded` / `Unbonded` / `Reward` / `Rewarded` carried the `IdentityId` as their first parameter
 * through v7.4.0; `Withdrawn` and `Slash` / `Slashed` never did (verified — defect log §C).
 */
registerShape('staking', 'Bonded', discontinuedAt(LAST_V7, ['identityId', 'stash', 'amount']));
registerShape('staking', 'Unbonded', discontinuedAt(LAST_V7, ['identityId', 'stash', 'amount']));
registerShape('staking', 'Reward', discontinuedAt(LAST_V7, ['identityId', 'stash', 'amount']));
registerShape('staking', 'Rewarded', discontinuedAt(LAST_V7, ['identityId', 'stash', 'amount']));
registerShape('staking', 'Withdrawn', discontinuedAt(LAST_V7, ['stash', 'amount']));
registerShape('staking', 'Slash', discontinuedAt(LAST_V7, ['stash', 'amount']));
registerShape('staking', 'Slashed', discontinuedAt(LAST_V7, ['stash', 'amount']));
