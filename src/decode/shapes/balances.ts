import { LAST_V7 } from './consts';
import { discontinuedAt, registerShape } from './registry';

/**
 * `balances` pallet parameter shapes.
 *
 * Polymesh ran a custom `balances` pallet with tuple-style events through v7.4. v8.0.0 deleted it
 * and moved to the upstream Substrate pallet, whose events are struct-style and decode straight
 * from the block metadata (`namedFields`) with no entry here. So every shape below closes at the
 * last 7.x spec version.
 *
 * Names come from the Rust event definitions (`pallets/balances/src/lib.rs` @ v7.4.0),
 * cross-checked against `docs/reference/event-shape-verification.md` and the positional reads the
 * pre-ledger `mapPolyxTransaction` handlers relied on.
 */

// Endowed(IdentityId, AccountId, Balance)
registerShape('balances', 'Endowed', discontinuedAt(LAST_V7, ['identityId', 'account', 'balance']));

// Transfer(Option<IdentityId>, AccountId, Option<IdentityId>, AccountId, Balance, Option<Memo>)
// The memo tail is absent on the transfers that did not carry one, so arity is 5 or 6.
registerShape('balances', 'Transfer', [
  {
    from: 0,
    to: LAST_V7,
    fields: ['fromIdentityId', 'from', 'toIdentityId', 'to', 'amount', 'memo'],
    optionalFrom: 5,
  },
]);

// TransferWithMemo(from, to, amount, memo) — introduced v7.4.0 only, emitted alongside `Transfer`
registerShape(
  'balances',
  'TransferWithMemo',
  discontinuedAt(LAST_V7, ['from', 'to', 'amount', 'memo'])
);

// Reserved(AccountId, Balance) / Unreserved(AccountId, Balance)
registerShape('balances', 'Reserved', discontinuedAt(LAST_V7, ['account', 'amount']));
registerShape('balances', 'Unreserved', discontinuedAt(LAST_V7, ['account', 'amount']));

// ReserveRepatriated(AccountId, AccountId, Balance, BalanceStatus)
registerShape(
  'balances',
  'ReserveRepatriated',
  discontinuedAt(LAST_V7, ['from', 'to', 'amount', 'destinationStatus'])
);

// BalanceSet(IdentityId, AccountId, free, reserved) — reserved is index 3 (defect A1)
registerShape(
  'balances',
  'BalanceSet',
  discontinuedAt(LAST_V7, ['identityId', 'account', 'free', 'reserved'])
);

// AccountBalanceBurned(IdentityId, AccountId, Balance) — the Polymesh burn event; no v8 equivalent
registerShape(
  'balances',
  'AccountBalanceBurned',
  discontinuedAt(LAST_V7, ['identityId', 'account', 'amount'])
);

// Deposit(AccountId, Balance)
registerShape('balances', 'Deposit', discontinuedAt(LAST_V7, ['account', 'amount']));

// 2-arg (AccountId, Balance) events that also existed pre-v8. Defensive: if a runtime emitted
// these as tuples the decoder covers them, and at v8 the struct-style metadata is used instead.
registerShape('balances', 'Burned', discontinuedAt(LAST_V7, ['account', 'amount']));
registerShape('balances', 'Slashed', discontinuedAt(LAST_V7, ['account', 'amount']));
registerShape('balances', 'Withdraw', discontinuedAt(LAST_V7, ['account', 'amount']));
registerShape('balances', 'Minted', discontinuedAt(LAST_V7, ['account', 'amount']));
registerShape('balances', 'Restored', discontinuedAt(LAST_V7, ['account', 'amount']));
registerShape('balances', 'DustLost', discontinuedAt(LAST_V7, ['account', 'amount']));
