# Event Shape Verification, v4.1.3 → v8.0.2

Event-by-event comparison against the Rust source for every domain with an implementation plan. All entries **[V]** unless marked otherwise.

Tags walked: `v4.1.3`, `v5.0.0-rc1`, `v5.4.3`, `v6.0.0`, `v6.3.5`, `v7.0.0`, `v7.4.0`, `v8.0.0`.

**Headline:** most domains are far more stable than the defect log implies. Across ~60 events there are **four** genuine positional/type changes and **three** removed events. Every remaining variance is `Ticker → AssetId` at 7.x, already handled by `getAssetId` / `getCaIdValue`.

---

## Summary of real changes

| # | Event(s) | Change | Boundary | Plan |
|---|---|---|---|---|
| 1 | `ScheduleCreated`, `ScheduleRemoved` | **arity 3 → 4** (`ScheduleId` inserted at index 2); payload `StoredSchedule` → `ScheduleCheckpoints` | v6.0.0 | [06](../implementation/06-corporate-actions.md) |
| 2 | `SecondaryKeysRemoved` | payload `Vec<Signatory<AccountId>>` → `Vec<AccountId>` | v5.0.0 | [04](../implementation/04-identity-keys.md) |
| 3 | `SecondaryKeyPermissionsUpdated` | arg 1 `SecondaryKey<AccountId>` → `AccountId` | v5.0.0 | [04](../implementation/04-identity-keys.md) |
| 4 | `AssetBalanceUpdated` | args 3,4 `Option<PortfolioId>` → `Option<AssetHolder>`; arg 5 `PortfolioUpdateReason` → `HoldingsUpdateReason` | v8.0.0 | [03](../implementation/03-holdings-nfts.md) |

### Removed events

| Event | Last present | Indexer state |
|---|---|---|
| `CAATransferred(IdentityId, Ticker, IdentityId)` | v5.4.3 | in enum, **not** in `project.ts` |
| `AssetDidRegistered(IdentityId, Ticker)` | v7.4.0 | handled; simply never fires post-v8 |
| `FungibleTokensMovedBetweenPortfolios`, `NFTsMovedBetweenPortfolios` | v5.4.3 | in enum, **not** in `project.ts` — see A8 below |

---

## Identity — plans [01](../implementation/01-claims.md) and [04](../implementation/04-identity-keys.md)

Stable v5.4.3 → v8.0.0, arity and types:

| Event | Signature | Args |
|---|---|---|
| `DidCreated` | `(IdentityId, AccountId, Vec<SecondaryKey<AccountId>>)` | 3 |
| `SecondaryKeysAdded` | `(IdentityId, Vec<SecondaryKey<AccountId>>)` | 2 |
| `SecondaryKeysRemoved` | `(IdentityId, Vec<AccountId>)` | 2 |
| `SecondaryKeyPermissionsUpdated` | `(IdentityId, AccountId, Permissions, Permissions)` | 4 |
| `PrimaryKeyUpdated` | `(IdentityId, AccountId, AccountId)` | 3 |
| `ClaimAdded` / `ClaimRevoked` | `(IdentityId, IdentityClaim)` | 2 |
| `SecondaryKeysFrozen` / `Unfrozen` | `(IdentityId)` | 1 |
| `ChildDidCreated` | `(IdentityId, IdentityId, AccountId)` | 3 |

### The pre-5.0 boundary is real

```
v4.1.3       SecondaryKeysRemoved(IdentityId, Vec<Signatory<AccountId>>)
v5.0.0-rc1+  SecondaryKeysRemoved(IdentityId, Vec<AccountId>)

v4.1.3       SecondaryKeyPermissionsUpdated(IdentityId, SecondaryKey<AccountId>, Permissions, Permissions)
v5.0.0+      SecondaryKeyPermissionsUpdated(IdentityId, AccountId,               Permissions, Permissions)
```

Arity unchanged; the *payload types* changed. This is exactly what the existing duck-typed branches in `mapIdentities.ts` (`instanceof Map`, `'key' in rest` vs `'signer' in rest`) handle — **they are correct**, and should become legacy decoder entries with the boundary at `5_000_000` rather than staying as inline shape sniffs.

**Implication for plan 01:** `ClaimAdded`/`ClaimRevoked` are 2-arg and unchanged across every version. The claim fix is **purely an id-composition change** — no version work at all.

---

## Corporate actions, checkpoints, ballots — plan [06](../implementation/06-corporate-actions.md)

Verified in full in that plan. Summary: `CAInitiated` and the `CorporateAction` struct are identical across all five tags; all six ballot events are byte-identical; the only change is `ScheduleCreated`/`ScheduleRemoved` (#1 above).

---

## Portfolio movement — plan [05](../implementation/05-movement-ledger.md)

```
v5.4.3   MovedBetweenPortfolios(IdentityId, PortfolioId, PortfolioId, Ticker, Balance, Option<Memo>)   — 6 args, fungible only
v6.0.0+  FundsMovedBetweenPortfolios(IdentityId, PortfolioId, PortfolioId, FundDescription, Option<Memo>) — 5 args, polymorphic
```

Different **event names**, so no positional collision — the indexer already routes them to separate handlers. Correct as-is.

`PortfolioCreated(IdentityId, PortfolioNumber, PortfolioName)` and `PortfolioCustodianChanged(IdentityId, PortfolioId, IdentityId)` are stable across all tags.

### A8 is a confirmed history gap, not dead enum values

Both events were **declared and emitted** at v5.4.3, in `unchecked_move_funds` (`pallets/portfolio/src/lib.rs:767, 781`):

```rust
FundDescription::Fungible { ticker, amount } => {
    …
    Self::deposit_event(Event::FungibleTokensMovedBetweenPortfolios(
        origin_did, sender_portfolio, receiver_portfolio, ticker, amount, fund.memo,
    ));
}
FundDescription::NonFungible(nfts) => {
    …
    Self::deposit_event(Event::NFTsMovedBetweenPortfolios(
        origin_did, sender_portfolio, receiver_portfolio, nfts, fund.memo,
    ))
}
```

Shapes: `FungibleTokensMovedBetweenPortfolios` — 6 args; `NFTsMovedBetweenPortfolios` — 5 args. Removed at v6.0.0.

**These are exclusive branches — `MovedBetweenPortfolios` is not emitted alongside them.** Neither is registered in `project.ts`. So any portfolio movement routed through `unchecked_move_funds` during the v5.x era is **absent from the index entirely**.

This upgrades defect A8 from *"needs a count query to see whether it is real"* to *"confirmed real code path; the count query now only sizes the impact."* Both events must be registered and handled for v5-era history.

---

## Assets — plan [03](../implementation/03-holdings-nfts.md)

### Pre-v6: three separate events

```
v5.4.3   Transfer(IdentityId, Ticker, PortfolioId, PortfolioId, Balance)              — 5
         Issued(IdentityId, Ticker, IdentityId, Balance, FundingRoundName, Balance)   — 6
         Redeemed(IdentityId, Ticker, IdentityId, Balance)                            — 4
```

No `AssetBalanceUpdated` exists before v6.

### v6.0.0+: one event with a reason

```
v6.0.0–v7.4  AssetBalanceUpdated(IdentityId, Ticker→AssetId, Balance,
                                 Option<PortfolioId>, Option<PortfolioId>, PortfolioUpdateReason)  — 6
v8.0.0       AssetBalanceUpdated(IdentityId, AssetId, Balance,
                                 Option<AssetHolder>,  Option<AssetHolder>,  HoldingsUpdateReason)  — 6
```

Arity stable at 6; **two payload changes at v8** (change #4). `AssetHolder` is the `{Account}|{Portfolio}` enum that introduces the account-level layer, and the reason enum was renamed, gaining the `ControllerTransfer` variant.

Both are already handled: `rawAssetHolderToAssetHolder` branches on `is8xChain`, and `processUpdateReason` branches on decoded JSON key names, which is version-tolerant for the shared variants. The genuine gap is only the missing `controllerTransfer` branch (defect A7).

`AssetCreated` at v5.4.3 carries 9 args including the `disableIu` bool, confirming the existing `specVersion >= 6000000` branch is correctly placed.

---

## External agents — plan [08](../implementation/08-external-agents.md)

Stable across v5.4.3 → v8.0.0; only `Ticker → AssetId` at 7.x:

| Event | Signature | Args |
|---|---|---|
| `GroupCreated` | `(EventDid, Ticker→AssetId, AGId, ExtrinsicPermissions)` | 4 |
| `GroupPermissionsUpdated` | `(EventDid, Ticker→AssetId, AGId, ExtrinsicPermissions)` | 4 |
| `AgentAdded` | `(EventDid, Ticker→AssetId, AgentGroup)` | 3 |
| `AgentRemoved` | `(EventDid, Ticker→AssetId, IdentityId)` | 3 |
| `GroupChanged` | `(EventDid, Ticker→AssetId, IdentityId, AgentGroup)` | 4 |

No version work required. Plan 08 is a pure modelling change.

---

## Balances and staking — plan [02](../implementation/02-polyx-ledger.md) / [07](../implementation/07-staking.md)

Verified earlier in the review; recorded here for completeness.

- `BalanceSet(IdentityId, AccountId, Balance, Balance)` — 4 args, reserved at index **3**, identical v5.4.3 → v7.4.0 (defect A1). v8: `BalanceSet { who, free }` — 2 fields.
- `Transfer` — 6 positional args ≤ v7.4; `{from,to,amount}` at v8.
- `TransferWithMemo { from, to, amount, memo }` — introduced **v7.4.0 only**, emitted alongside `Transfer` (defect A2).
- `Reserved(who,v)` → `free -= v; reserved += v`; `Unreserved` the inverse.
- Staking `Bonded`/`Unbonded`/`Rewarded` carry `IdentityId` through v7.4; dropped at v8 when the pallet moved upstream.
- v7.4 staking uses `set_lock(STAKING_ID, …)` — **no balance moves**; v8 uses a `RuntimeHoldReason::Staking` hold — **balance moves**. Same event names, inverted semantics (defect A10).
- `PayoutStarted { eraIndex, validatorStash, page, next }` supplies the era that `Rewarded` lacks.

---

## What this changes in the plans

1. **[05](../implementation/05-movement-ledger.md)** — A8 is confirmed. Register and handle `FungibleTokensMovedBetweenPortfolios` and `NFTsMovedBetweenPortfolios`; v5-era movements are otherwise lost. **Largest new finding from this pass.**
2. **[06](../implementation/06-corporate-actions.md)** — legacy decoder for the schedule events; `CAATransferred` decision.
3. **[04](../implementation/04-identity-keys.md)** — convert the duck-typed pre-5.0 branches into legacy decoder entries at `5_000_000`; note `AssetDidRegistered` stops firing at v8.
4. **[01](../implementation/01-claims.md)** — no version work; the fix is purely id composition.
5. **[03](../implementation/03-holdings-nfts.md)** — existing v8 branches are correct; only the `controllerTransfer` branch is missing.
6. **[08](../implementation/08-external-agents.md)** — no version work.

## Method note

`polymesh-types` `types-lookup.ts` is authoritative for **shapes** but camelCases variant **names** (`NFTHoldingsUpdated` → `NftHoldingsUpdated`). Event names must be read from the Rust source. One apparent casing bug in `project.ts` dissolved on checking this.
