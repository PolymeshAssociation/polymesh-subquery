# 00 — Defect fixes

Standalone corrections. None require the redesign; all are in scope for the resync.

Source: [`../reference/defect-log.md`](../reference/defect-log.md).

---

## A1 — `BalanceSet` reserved balance never written

**File:** [`src/mappings/entities/identities/mapPolyxTransaction.ts:378-380`](../../src/mappings/entities/identities/mapPolyxTransaction.ts#L378)

```diff
  if (!is8xChain(args.block)) {
-   reservedAmount = getBigIntValue(args.params[4]);
+   reservedAmount = getBigIntValue(args.params[3]);
  }
```

Chain emits `BalanceSet(IdentityId, AccountId, Balance, Balance)` — 4 params, reserved at index **3**, identical at v5.4.3 / v6.3.5 / v7.0.0 / v7.4.0 **[V]**. `params[4]` is out of bounds → `BigInt(0)` → the `if (reservedAmount)` guard skips the write.

**Note:** superseded by [02](./02-polyx-ledger.md) if that lands first — `BalanceSet` becomes a *checkpoint*, not a movement. Fix it here anyway; 02 is larger and this is one character.

**Test:** fixture for a pre-8x `BalanceSet` asserting both a Free and a Reserved row.

---

## A3 — `handleBalanceSuspended` does not exist

**File:** `project.ts:72` — `Suspended: ['handleBalanceSuspended']`, no such export in `src/`.

Two options:
1. Implement it in `mapPolyxTransaction.ts` — `Suspended { who, amount }` is a v8 upstream event; treat as `Free → ∅` (funds suspended out of circulation).
2. Set it to `[]`.

**Recommended:** implement. It is a real balance change and leaving it `[]` re-creates the coverage gap.

Closed permanently by the build-time export check in [09](./09-infrastructure.md).

---

## A4 — Stale settlement workaround runs on every block

**File:** [`src/mappings/entities/settlements/mapSettlement.ts:317-320`](../../src/mappings/entities/settlements/mapSettlement.ts#L317)

```diff
  if (
-   (block.specVersion >= 6001000 && block.specVersion <= 6003001) ||
-   specName !== 'polymesh_private_dev'
+   (specName !== 'polymesh_private_dev' &&
+     block.specVersion >= 6001000 && block.specVersion <= 6003001)
  ) {
```

The `||` makes the condition true for every non-private chain at any spec version, so the `InstructionAutomaticallyAffirmed` re-scan runs on every mainnet block instead of only 6.1.0–6.3.1.

**[I]** The private-chain equivalent range is unknown. If private chains need the workaround, add an explicit second clause with their range rather than folding it into the same expression — that ambiguity is what produced the bug.

**Test:** assert the re-scan does not run at spec 8_000_000.

---

## A6 — `staking.Withdrawn` recorded as a credit

**File:** `mapPolyxTransaction.ts` — `handleWithdrawn` currently calls `handleBalanceAdded(event, BalanceTypeEnum.Unbonded)`.

`withdraw_unbonded` *drains* the unbonding queue — "essentially frees up that balance" **[V]**. Recording another credit to `Unbonded` means `SUM(type=Unbonded)` only ever grows.

Under the current schema the minimal correction is a **debit** from `Unbonded`. Under [02](./02-polyx-ledger.md) it becomes `Unbonded → Free`, which is the real fix. If 02 is close, do it there and skip the interim change.

---

## A7 — `ControllerTransfer` unhandled in `processUpdateReason`

**File:** [`src/mappings/entities/assets/mapAsset.ts:545-584`](../../src/mappings/entities/assets/mapAsset.ts#L545)

`HoldingsUpdateReason` has four variants **[V]**; the function branches on three and falls through to `{ eventId: undefined, assetDelta: {} }`.

```diff
+ if (updateReason === 'controllerTransfer') {
+   return {
+     eventId: EventIdEnum.ControllerTransfer,
+     assetDelta: { totalTransfers: BigInt(1) },
+   };
+ }
```

Fixes two things together: `totalTransfers` is no longer under-counted, and `eventId` stops falling back to the extrinsic call name (which yields the wrong id for a batched controller transfer).

Also set `project.ts` `asset.ControllerTransfer` — currently `[]`.

**Test:** fixture for an `AssetBalanceUpdated` with a `controllerTransfer` reason, asserting `totalTransfers` increments and `eventId` is correct inside a batch.

---

## A9 — v8 `reserved` is entirely unindexed

Eight v8 `balances` events are in `EventIdEnum` but absent from `project.ts` **[V]**: `Held`, `Released`, `BurnedHeld`, `TransferOnHold`, `TransferAndHold`, `MintedCredit`, `BurnedDebt`, `Unexpected`. `DustLost` and `Thawed` are registered `[]`.

**Minimum here:** register `Held` and `Released` — without them, bonded POLYX never reaches `reserved` on v8, since v8 staking bonds via a Hold.

Full treatment (all eight, with pool transitions) is [02](./02-polyx-ledger.md). If 02 is imminent, do it all there rather than writing handlers twice.

---

## A11 — Stale `ChildIdentity` rows

The v8 upgrade deleted every child identity in a storage migration with **no events** **[V]**:

```rust
for (child_did, parent_did) in ParentDid::<T>::drain() {
    ChildDid::<T>::remove(&parent_did, &child_did);
}
```

The indexer cannot see an absence, so `ChildIdentity` rows persist forever.

**Fix:** on crossing the v8 boundary, remove all `ChildIdentity` rows. Requires the `ChainUpgrade` hook from [09](./09-infrastructure.md) — a spec-version transition into ≥ 8_000_000 triggers a one-off retirement.

Do **not** implement this as a module-level flag; it must be driven from persisted upgrade state so it is deterministic under `--workers` and across restarts.

**[I]** Confirm the exact upgrade block per network (mainnet/testnet/private) before implementing; the trigger is the spec transition, not a hardcoded height.

**Test:** simulate a block at spec 7_004_001 followed by one at 8_000_000; assert `ChildIdentity` is empty afterwards.

---

## A2 — `TransferWithMemo` double-write and 7.4.x misdecode

**Blocked on a decision.** The chain emits `TransferWithMemo` *alongside* `Transfer` for one transfer **[V]**. Today both route to `handleBalanceTransfer`, which branches only on `is8xChain`:

- **7.4.x** (`7_004_001 ≤ spec < 8_000_000`): the 4-field named struct is decoded with the 6-positional legacy layout → a zero-amount row with an address in `identityId` and a memo in `toAddress`.
- **8.x**: both decode correctly but produce **two rows for one transfer**.

Options:
- **(a)** Drop `TransferWithMemo` from `project.ts`. Pre-v8 `Transfer` carries the memo at index 5; v8 `Transfer` does not, so memo is lost on v8.
- **(b)** Use `TransferWithMemo` only to enrich the paired `Transfer` row with its memo, never to create a row. Preserves memo on both eras, no double count.

**Recommended: (b).** It is the only option that keeps the memo on v8 without double counting. Under [02](./02-polyx-ledger.md) this becomes explicit: `TransferWithMemo` is memo enrichment, not a movement.

Name-based decoding ([09](./09-infrastructure.md)) removes the misdecode regardless of which option is chosen — the 7.4.x bug is a positional-decode artefact.

---

## Sequencing within this plan

1. A1, A4, A7 — one-line/small, independent, no dependencies.
2. A3 — implement `handleBalanceSuspended`.
3. A9 minimum — register `Held`/`Released`.
4. A2 — once the routing decision is made.
5. A6, A11 — fold into [02](./02-polyx-ledger.md) and [09](./09-infrastructure.md) respectively if those are close; otherwise do standalone.

## Consumer impact

None. Every fix here corrects values within the existing schema shape; no field or entity is added or removed. `polyxTransactions` and `assetTransactions` return the same shape with corrected data.
