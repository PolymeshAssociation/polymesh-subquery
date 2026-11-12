import { LAST_V6 } from './consts';
import { discontinuedAt, registerShape } from './registry';

/**
 * `bridge` pallet parameter shapes. The pallet declared its events as tuples throughout its life
 * and was removed with 7.0.0, so these are the only names its events will ever have.
 *
 * Nothing names them on the chain, so they come from the pallet's doc comments and the calls that
 * deposit each event. The first `IdentityId` is the identity that acted (the bridge admin, a freeze
 * admin, or the council when the bridge itself acted), `callerDid` as in the other pallets.
 */
registerShape('bridge', 'AdminChanged', discontinuedAt(LAST_V6, ['callerDid', 'newAdmin']));
registerShape('bridge', 'FreezeAdminAdded', discontinuedAt(LAST_V6, ['callerDid', 'freezeAdmin']));
registerShape('bridge', 'Frozen', discontinuedAt(LAST_V6, ['callerDid']));
registerShape('bridge', 'Unfrozen', discontinuedAt(LAST_V6, ['callerDid']));
registerShape('bridge', 'Bridged', discontinuedAt(LAST_V6, ['callerDid', 'bridgeTx']));
registerShape('bridge', 'FrozenTx', discontinuedAt(LAST_V6, ['callerDid', 'bridgeTx']));
registerShape('bridge', 'UnfrozenTx', discontinuedAt(LAST_V6, ['callerDid', 'bridgeTx']));

/** The block the scheduled transaction will be handled in */
registerShape(
  'bridge',
  'BridgeTxScheduled',
  discontinuedAt(LAST_V6, ['callerDid', 'bridgeTx', 'executionBlock'])
);

/** One `(recipient, nonce, status)` per transaction the batch handled */
registerShape('bridge', 'TxsHandled', discontinuedAt(LAST_V6, ['handledTxs']));
