import { LAST_V6, LAST_V7 } from './consts';
import { discontinuedAt, registerShape, stable } from './registry';

/**
 * `staking` pallet parameter shapes for the pre-v8 (Polymesh custom staking pallet) tuple events.
 *
 * v8.0.0 deleted the custom pallet and moved to upstream Substrate staking, whose events are
 * struct-style and decode from block metadata directly. So every shape here closes at the last
 * 7.x spec version.
 *
 * `Bonded` / `Unbonded` / `Reward` / `Rewarded` carried the `IdentityId` as their first parameter
 * through v7.4.0; `Withdrawn` and `Slash` / `Slashed` never did.
 */
registerShape('staking', 'Bonded', discontinuedAt(LAST_V7, ['identity', 'stash', 'amount']));
registerShape('staking', 'Unbonded', discontinuedAt(LAST_V7, ['identity', 'stash', 'amount']));
registerShape('staking', 'Reward', discontinuedAt(LAST_V7, ['identity', 'stash', 'amount']));
registerShape('staking', 'Rewarded', discontinuedAt(LAST_V7, ['identity', 'stash', 'amount']));
registerShape('staking', 'Withdrawn', discontinuedAt(LAST_V7, ['stash', 'amount']));
registerShape('staking', 'Slash', discontinuedAt(LAST_V7, ['stash', 'amount']));
registerShape('staking', 'Slashed', discontinuedAt(LAST_V7, ['staker', 'amount']));

/**
 * Polymesh's own v7.4 `staking` pallet already carried the validator/nomination surface later
 * split into the `validators` pallet at v8.0.0; `Nominated`'s fields are the same on both sides.
 */
registerShape(
  'staking',
  'Nominated',
  discontinuedAt(LAST_V7, ['nominatorIdentity', 'stash', 'targets'])
);

/** `Chilled` and `Kicked` have the same fields as their v8 counterparts. */
registerShape('staking', 'Chilled', discontinuedAt(LAST_V7, ['stash']));
registerShape('staking', 'Kicked', discontinuedAt(LAST_V7, ['nominator', 'stash']));

/**
 * `ValidatorPrefsSet` and the identity-permissioning events have the same fields as the
 * `validators` module's v8 shapes.
 */
registerShape('staking', 'ValidatorPrefsSet', discontinuedAt(LAST_V7, ['stash', 'prefs']));
registerShape(
  'staking',
  'PermissionedIdentityAdded',
  discontinuedAt(LAST_V7, ['governanceCouncillDid', 'validatorsIdentity'])
);
registerShape(
  'staking',
  'PermissionedIdentityRemoved',
  discontinuedAt(LAST_V7, ['governanceCouncillDid', 'validatorsIdentity'])
);
registerShape(
  'staking',
  'SlashReported',
  discontinuedAt(LAST_V7, ['validator', 'fraction', 'slashEra'])
);
registerShape(
  'staking',
  'EraPaid',
  discontinuedAt(LAST_V7, ['eraIndex', 'validatorPayout', 'remainder'])
);

/**
 * `EraPayout(EraIndex, Balance, Balance)` is what `EraPaid` was called before v7.0.0, deposited
 * from `end_era` as `(active_era.index, validator_payout, rest)`, so it takes `EraPaid`'s field
 * names and handler.
 */
registerShape(
  'staking',
  'EraPayout',
  discontinuedAt(LAST_V7, ['eraIndex', 'validatorPayout', 'remainder'])
);

/**
 * `StakersElected` carries no payload in either era (`AugmentedEvent<ApiType, []>`) — the era
 * index and elected validator set are resolved from chain storage when it fires (see
 * `mapEra.ts`). `hasNamedFields()` reports `false` for any zero-argument event regardless of era
 * (`names.length > 0` is never true for an empty array), so even the v8 named-struct era needs an
 * explicit shape here or `decodeEvent` throws `NoDecoderForSpecVersion`.
 */
registerShape('staking', 'StakersElected', stable([]));

/**
 * The pre-7.0.0 events no runtime names. 7.0.0 names `InvalidatedNominators` and
 * `SlashingAllowedForChanged` with the fields below, spelling and all; `MinimumBondThresholdUpdated`
 * and the election events were never named. The former carries the council's identity, as
 * `PermissionedIdentityAdded` does, and the new threshold.
 */
registerShape(
  'staking',
  'InvalidatedNominators',
  discontinuedAt(LAST_V6, [
    'governanceCouncillDid',
    'governanceCouncillAccount',
    'expiredNominators',
  ])
);
registerShape(
  'staking',
  'MinimumBondThresholdUpdated',
  discontinuedAt(LAST_V6, ['governanceCouncillDid', 'newValue'])
);
registerShape('staking', 'SlashingAllowedForChanged', discontinuedAt(LAST_V6, ['slashingSwitch']));
registerShape('staking', 'SolutionStored', discontinuedAt(LAST_V6, ['compute']));
registerShape('staking', 'StakingElection', discontinuedAt(LAST_V6, ['compute']));
