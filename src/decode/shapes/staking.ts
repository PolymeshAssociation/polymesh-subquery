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

/**
 * Verified against `pallets/staking/src/pallet/mod.rs` at v7.4.0: at that version Polymesh's own
 * custom `staking` pallet already carried the full validator/nomination surface later split into
 * the dedicated `validators` pallet at v8.0.0 — `Nominated`'s shape is unchanged across that
 * split (`nominatorIdentity, stash, targets`, same order both sides), only the module and the
 * struct-vs-tuple encoding change.
 */
registerShape(
  'staking',
  'Nominated',
  discontinuedAt(LAST_V7, ['nominatorIdentity', 'stash', 'targets'])
);

/**
 * Same v7.4.0 source: `Chilled { stash }` and `Kicked { nominator, stash }` both exist there,
 * shape-identical to their v8 counterparts — missing here, a pre-v8 `Chilled`/`Kicked` would
 * throw `NoDecoderForSpecVersion` unhandled.
 */
registerShape('staking', 'Chilled', discontinuedAt(LAST_V7, ['stash']));
registerShape('staking', 'Kicked', discontinuedAt(LAST_V7, ['nominator', 'stash']));
