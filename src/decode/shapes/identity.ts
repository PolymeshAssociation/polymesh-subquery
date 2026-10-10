import { LAST_V7 } from './consts';
import { discontinuedAt, registerShape, stable } from './registry';

/**
 * `identity` pallet parameter shapes.
 *
 * Two events changed their *payload types* at 5.0.0 - `SecondaryKeysRemoved` went from
 * `Vec<Signatory<AccountId>>` to `Vec<AccountId>`, and `SecondaryKeyPermissionsUpdated`'s second
 * parameter from `SecondaryKey<AccountId>` to `AccountId`. Arity is unchanged in both cases, so
 * the shape table has nothing to say about them; the duck-typed branches in `mapIdentities` are
 * the correct handling and stay where they are.
 *
 * The three child-identity events and `AssetDidRegistered` do not exist in the v8 runtime, so
 * their ranges close at the last 7.x spec version.
 */
registerShape('identity', 'DidCreated', stable(['did', 'primaryKey', 'secondaryKeys']));
registerShape('identity', 'SecondaryKeysAdded', stable(['did', 'secondaryKeys']));
registerShape('identity', 'SecondaryKeysRemoved', stable(['did', 'removedKeys']));
registerShape('identity', 'SecondaryKeyLeftIdentity', stable(['did', 'secondaryKey']));
// Absent from the v8 runtime
registerShape('identity', 'SignerLeft', discontinuedAt(LAST_V7, ['did', 'signer']));
registerShape(
  'identity',
  'SecondaryKeyPermissionsUpdated',
  stable(['did', 'secondaryKey', 'oldPermissions', 'newPermissions'])
);
registerShape('identity', 'SecondaryKeysFrozen', stable(['did']));
registerShape('identity', 'SecondaryKeysUnfrozen', stable(['did']));
registerShape('identity', 'PrimaryKeyUpdated', stable(['did', 'oldPrimaryKey', 'newPrimaryKey']));
registerShape('identity', 'ClaimAdded', stable(['targetDid', 'claim']));
registerShape('identity', 'ClaimRevoked', stable(['targetDid', 'claim']));
registerShape(
  'identity',
  'CustomClaimTypeAdded',
  stable(['callerDid', 'customClaimTypeId', 'name'])
);

registerShape(
  'identity',
  'AuthorizationAdded',
  stable(['authorizedBy', 'targetDid', 'targetKey', 'authId', 'authorizationData', 'expiry'])
);

const authorizationOutcome = ['targetDid', 'targetKey', 'authId'];

registerShape('identity', 'AuthorizationRevoked', stable(authorizationOutcome));
registerShape('identity', 'AuthorizationRejected', stable(authorizationOutcome));
registerShape('identity', 'AuthorizationConsumed', stable(authorizationOutcome));
registerShape('identity', 'AuthorizationRetryLimitReached', stable(authorizationOutcome));

registerShape(
  'identity',
  'ChildDidCreated',
  discontinuedAt(LAST_V7, ['did', 'childDid', 'account'])
);
registerShape(
  'identity',
  'ChildDidUnlinked',
  discontinuedAt(LAST_V7, ['did', 'parentDid', 'childDid'])
);
registerShape('identity', 'AssetDidRegistered', discontinuedAt(LAST_V7, ['did', 'ticker']));
