import { LAST_V7 } from './consts';
import { registerShape } from './registry';

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
registerShape('identity', 'DidCreated', [
  { from: 0, fields: ['did', 'primaryKey', 'secondaryKeys'] },
]);
registerShape('identity', 'SecondaryKeysAdded', [{ from: 0, fields: ['did', 'secondaryKeys'] }]);
registerShape('identity', 'SecondaryKeysRemoved', [{ from: 0, fields: ['did', 'signers'] }]);
registerShape('identity', 'SecondaryKeyLeftIdentity', [{ from: 0, fields: ['did', 'account'] }]);
// Absent from the v8 runtime
registerShape('identity', 'SignerLeft', [{ from: 0, to: LAST_V7, fields: ['did', 'signer'] }]);
registerShape('identity', 'SecondaryKeyPermissionsUpdated', [
  { from: 0, fields: ['did', 'account', 'previousPermissions', 'updatedPermissions'] },
]);
registerShape('identity', 'SecondaryKeysFrozen', [{ from: 0, fields: ['did'] }]);
registerShape('identity', 'SecondaryKeysUnfrozen', [{ from: 0, fields: ['did'] }]);
registerShape('identity', 'PrimaryKeyUpdated', [
  { from: 0, fields: ['did', 'previousPrimaryKey', 'newPrimaryKey'] },
]);
registerShape('identity', 'ClaimAdded', [{ from: 0, fields: ['did', 'claim'] }]);
registerShape('identity', 'ClaimRevoked', [{ from: 0, fields: ['did', 'claim'] }]);
registerShape('identity', 'CustomClaimTypeAdded', [
  { from: 0, fields: ['did', 'customClaimTypeId', 'name'] },
]);

registerShape('identity', 'AuthorizationAdded', [
  {
    from: 0,
    fields: ['fromDid', 'toDid', 'toKey', 'authId', 'authorizationData', 'expiry'],
  },
]);

const authorizationOutcome = ['toDid', 'toKey', 'authId'];

registerShape('identity', 'AuthorizationRevoked', [{ from: 0, fields: authorizationOutcome }]);
registerShape('identity', 'AuthorizationRejected', [{ from: 0, fields: authorizationOutcome }]);
registerShape('identity', 'AuthorizationConsumed', [{ from: 0, fields: authorizationOutcome }]);

registerShape('identity', 'ChildDidCreated', [
  { from: 0, to: LAST_V7, fields: ['did', 'childDid', 'account'] },
]);
registerShape('identity', 'ChildDidUnlinked', [
  { from: 0, to: LAST_V7, fields: ['did', 'parentDid', 'childDid'] },
]);
registerShape('identity', 'AssetDidRegistered', [
  { from: 0, to: LAST_V7, fields: ['did', 'ticker'] },
]);
