# Polymesh SubQuery — Indexer Audit & Improvement Backlog

Working document. Branch audited: `alpha`. Chain source cross-referenced: `PolymeshAssociation/Polymesh` tags `v4.1.x` → `v8.0.2`.

Status legend: **CONFIRMED** = verified against chain source (Rust) or reproduced in code. **SUSPECTED** = plausible, not yet verified. **DESIGN** = improvement proposal, not a defect.

---

## Decisions taken (2026-08-31)

1. **Breaking changes are accepted.** The redesign may replace entities outright rather than shadow them. The three-phase *additive → deprecate → remove* staging described in `polyx-balance-model.md` §5/§7 and `identity-asset-model.md` §1.3 was written under a constraint that no longer applies — read those sections as historical. Backfill from genesis is still required regardless; breaking-change freedom lifts the schema constraint, not the reindex constraint.

2. **Consumer surface is established.** `polymesh-sdk` (27 entity connections) and `polymesh-portal` (6) are the two direct GraphQL consumers; `polymesh-rest-api` has no direct queries and goes through the SDK. Full analysis in [`consumer-queries.md`](./consumer-queries.md), which also **escalates the Claim issuer collision to the top of this list** — it is the only finding that silently returns wrong answers to a compliance code path.

---

## Key structural fact

**v8.0.0 deleted Polymesh's custom `balances` and `staking` pallets** and moved to upstream Substrate via `polkadot-sdk` branch `polymesh-v8-stable2603-2`. This is the root cause of nearly all 8.x event-shape changes: upstream pallets have no concept of `IdentityId`, so DIDs disappeared from event arguments.

Reference spec versions (from `pallets/runtime/mainnet/src/runtime.rs`, format `aaa_bbb_ccd` for `vaaa.bbb.cc`):

| Tag | spec_version |
|---|---|
| v7.3.0 | `7_003_003` |
| v7.4.0 | `7_004_001` |
| v8.0.0 | `8_000_000` |

Version gating helpers live in [`src/utils/common.ts`](../../src/utils/common.ts): `is7xChain` (≥ 7_000_000), `is7Dot3Chain` (≥ 7_003_000), `is8xChain` (≥ 8_000_000), each with a `polymesh_private_dev` offset branch (2_000_000 / 2_001_000 / 2_002_000).

---

## A. Confirmed defects

### A1. `BalanceSet` reserved balance is never indexed — CONFIRMED, regression, affects all pre-8.x blocks

**Location:** [`src/mappings/entities/identities/mapPolyxTransaction.ts:378-380`](../../src/mappings/entities/identities/mapPolyxTransaction.ts#L378)

Handler reads `args.params[4]`. Chain emits **4 params**, reserved at **index 3**. Verified identical at v5.4.3, v6.3.5, v7.0.0, v7.4.0:

```rust
BalanceSet(IdentityId, T::AccountId, Balance, Balance)  // [did, who, free, reserved]
```

`params[4]` → `undefined` → `getBigIntValue(undefined)` → `BigInt(0)` → falsy → `if (reservedAmount)` guard skips the write. **The reserved-balance `PolyxTransaction` row is silently never created.** No error, no log.

Introduced by commit `1cf4c4b` ("chore: add balance handlers"), which replaced correct destructuring:

```diff
- const [rawDid, rawAddress, rawFreeBalance, rawReservedBalance] = args.params;
- reservedAmount = getBigIntValue(rawReservedBalance);   // index 3 ✅
+ reservedAmount = getBigIntValue(args.params[4]);       // index 4 ❌
```

**Fix:** `args.params[3]`. **Requires reindex** of affected range to recover lost rows.

---

### A2. `TransferWithMemo` mis-decoded on v7.4.x — CONFIRMED

**Location:** [`src/mappings/entities/identities/mapPolyxTransaction.ts:156-189`](../../src/mappings/entities/identities/mapPolyxTransaction.ts#L156), routed from `project.ts:76`

`TransferWithMemo` was introduced **in v7.4.0 only** (absent at v7.0/7.1/7.2/7.3) as a *named 4-field struct*, and is emitted **alongside** the classic 6-field positional `Transfer` for a single `transfer_with_memo` call (`pallets/balances/src/lib.rs:888` @ v7.4.0).

`project.ts` routes both to `handleBalanceTransfer`, which branches only on `is8xChain`. In the window **`7_004_001 ≤ spec < 8_000_000`** that is false, so the 4-param event is decoded with the 6-param legacy layout:

| param | actual | decoded as |
|---|---|---|
| `[0]` | `from` (account) | `identityId` (expects DID) |
| `[1]` | `to` (account) | `address` (expects from) |
| `[2]` | `amount` | `toId` (expects DID) |
| `[3]` | `memo` | `toAddress` |
| `[4]` | — | `amount` → **`BigInt(0)`** |

Produces a spurious zero-amount row with an SS58 address in `identityId` and a memo string in `toAddress`, in addition to the correct row from `Transfer`.

**Related design issue:** at 8.x both events decode correctly but still produce **two rows for one transfer** (dedup logic only checks `Endowed`), so `transfer_with_memo` is double-counted. Open decision: drop `TransferWithMemo` from `project.ts` (pre-8.x `Transfer` already carries the memo at index 5), or make it the memo source on 8.x and skip `Transfer`.

---

### A3. `handleBalanceSuspended` does not exist — CONFIRMED, latent 8.x failure

**Location:** `project.ts:72` registers `Suspended: ['handleBalanceSuspended']`; no such export exists anywhere in `src/` (`src/index.ts` re-exports `./mappings/entities` only).

`balances.Suspended` is an upstream-only event, so it can only fire on 8.x chains, where handler resolution will fail.

**Fix:** implement it, or remove the registration.

---

### A4. Stale legacy workaround runs on every block — CONFIRMED

**Location:** [`src/mappings/entities/settlements/mapSettlement.ts:317-320`](../../src/mappings/entities/settlements/mapSettlement.ts#L317)

```js
if (
  (block.specVersion >= 6001000 && block.specVersion <= 6003001) ||
  specName !== 'polymesh_private_dev'
) {
```

The comment scopes this `InstructionAutomaticallyAffirmed` re-scan to spec 6.1.0–6.3.1, but `||` makes the whole condition true for **any non-private chain regardless of spec version** — i.e. every mainnet/testnet block including current v8.x.

Idempotent (deterministic IDs), so no data corruption, but it runs a full `block.events` scan + redundant `mapAutomaticAffirmation` on the hottest settlement path for the entire post-6.3.1 history.

**Fix:** almost certainly `&&`, scoping the private-chain case separately.

---

### A5. ~~`mapChainUpgrade` reads the live runtime version~~ — **RETRACTED, claim was wrong**

An earlier revision of this document claimed `api.rpc.state.getRuntimeVersion()` in [`mapChainUpgrade.ts:44`](../../src/mappings/entities/block/mapChainUpgrade.ts#L44) returns the chain head during backfill. **That is incorrect.** Verified from upstream:

- `@subql/node/dist/indexer/api.service.js` → `getPatchedApi()` builds `apiAt = await api.at(currentBlockHash, runtimeVersion)` and then calls `patchApiRpc(api, apiAt)`.
- `redecorateRpcFunction()` inspects each RPC method's params for `isHistoric`. If found and the caller passes `undefined` for that arg, it **injects `currentBlockHash`**; if a hash *ahead* of the current block is passed explicitly, it throws. RPC methods with no historic param are replaced with `NOT_SUPPORT` (they throw).
- `@polkadot/types/interfaces/state/rpc.js:244` declares `getRuntimeVersion` with `params: [{ name: 'at', type: 'BlockHash', isHistoric: true, isOptional: true }]`.

So the no-arg call resolves to the runtime version **at the block being indexed**, and the explicit `getRuntimeVersion(parentBlockHash)` at line 27 is likewise fine. The global `api` inside a handler is block-scoped throughout.

**Residual, lower-severity concern (still open):** the file keeps `oldTxVersion` / `oldSpecVersion` as module-level mutable state. Under `--workers` each worker thread holds its own copy, so the "has the spec version changed since the last block I saw" question is answered per-worker against a non-contiguous block sequence rather than against chain history. The `oldTxVersion === 0` bootstrap makes each worker self-heal from its first block's parent, so this is not a correctness disaster, but upgrade-boundary detection (which triggers `handleMultiSigProposalDeleted`) can fire more than once or at worker-local boundaries. Persisting a `ChainUpgrade` entity would make this deterministic and also give backfills a spec→block map.

---

### A6. `BalanceTypeEnum` conflates three unrelated systems; bucket balances are not derivable — CONFIRMED, design-level

**Location:** [`mapPolyxTransaction.ts`](../../src/mappings/entities/identities/mapPolyxTransaction.ts) throughout; `BalanceTypeEnum` at `schema.graphql:2895`.

Chain evidence (`pallets/balances/src/lib.rs` @ v7.4.0):

```rust
pub struct AccountData {
    pub free: Balance,
    pub reserved: Balance,
    pub misc_frozen: Balance,   // a FLOOR on `free`, not a pool
    pub fee_frozen: Balance,    // a FLOOR on `free`, not a pool
}
```

There are exactly **two** balance pools on chain: `free` and `reserved`. `BalanceTypeEnum { Free, Reserved, Locked, Bonded, Unbonded }` mixes three incompatible concepts:

| Enum value | What it actually is |
|---|---|
| `Free`, `Reserved` | Real `AccountData` pools |
| `Locked` | A *floor* on `free` (`misc_frozen`/`fee_frozen`). No balance moves when a lock is set. |
| `Bonded`, `Unbonded` | Staking-ledger state, backed by a lock on `free`. The tokens never leave `free` in the balances pallet. |

**Every intra-account movement is recorded as a one-sided row, so no pool balance can be reconstructed by summing.** Verified emissions:

| Event | Chain effect (verified) | Current handler | Row written |
|---|---|---|---|
| `Reserved(who, v)` | `free -= v; reserved += v` (`lib.rs:1250-1261`) | `handleBalanceCharged(Reserved)` | debit side only, `type=Reserved` |
| `Unreserved(who, v)` | `reserved -= v; free += v` (`lib.rs:1278-1287`) | `handleBalanceAdded(Free)` | credit side only, `type=Free` |
| `staking.Unbonded` | `active -= v`, pushed to unlocking queue | `handleBalanceReceived(Unbonded)` | credit, `type=Unbonded` |
| `staking.Withdrawn` | leaves unlocking queue — *"essentially frees up that balance"* (`pallet/mod.rs:1279-1286`) | `handleBalanceAdded(Unbonded)` | **credit**, `type=Unbonded` |

The `Withdrawn` row is the clearest defect: withdrawal *drains* the unbonding queue, but is recorded as another **credit** to `Unbonded`. Summing `type=Unbonded` therefore yields `Unbonded credits + Withdrawn credits` and **never decreases** — the unbonding balance grows monotonically and is simply wrong.

The same shape of error applies to `Reserved`/`Unreserved`: the two are recorded with opposite conventions (one debit-side, one credit-side) and neither records its counterparty pool, so `SUM(Reserved) - SUM(...)` reconstructs nothing.

**Root cause:** the entity has a single `type` column, but a balance movement has **two sides that can sit in different pools**. Full ground-up redesign in [`polyx-balance-model.md`](./polyx-balance-model.md), which supersedes the sketch in the architecture review §4.5 and adds the findings below (A9/A10) discovered while working it through.

---

### A9. On v8, the entire `reserved` mechanism is unindexed — CONFIRMED, severe

**[V]** The complete v8 `balances` event surface (31 variants, `polymesh-types@feat/8.0.1-types` → `types-lookup.ts:4009`) includes eight events that are **in `schema.graphql`'s enum but absent from `project.ts` and unhandled in `src/`**:

`Held` · `Released` · `BurnedHeld` · `TransferOnHold` · `TransferAndHold` · `MintedCredit` · `BurnedDebt` · `Unexpected`

`Held` / `Released` are precisely how `reserved` balance is created and destroyed under the upstream fungible-Holds API. Since **v8 staking bonds via a Hold** (`RuntimeHoldReason::Staking`, `types-lookup.ts:4032`), bonded POLYX never reaches `reserved` in the index at all.

Additionally `DustLost` and `Thawed` are registered in `project.ts` with an empty handler list (`[]`), so account reaping — a real balance change — is not recorded.

---

### A10. `staking.Bonded` means the opposite thing pre- and post-v8 — CONFIRMED

| Era | Mechanism | Balance effect |
|---|---|---|
| ≤ v7.4 **[V]** `pallets/staking/src/pallet/impls.rs:313` — `T::Currency::set_lock(STAKING_ID, …)` via `LockableCurrency` | **Lock** | **None.** `free` unchanged; `misc_frozen` rises. |
| v8 **[V]** `PalletStakingPalletHoldReason` / `RuntimeHoldReason::Staking` | **Hold** | `free -= v; reserved += v`, emitting `balances.Held` |

The same event name carries opposite balance semantics across the boundary, and the handler treats both identically — so pre-v8 it records a movement that never happened, and post-v8 it records the staking-ledger transition while missing the actual `Held` movement.

**[V]** Only two lock identifiers exist pre-v8: `STAKING_ID = *b"staking "` and `PIPS_LOCK_ID = *b"pips    "` (`pallets/pips/src/types.rs:43`). PIPs vote locks are entirely unmodelled.

Related **[V]**: `AccountData` itself changed shape — `{free, reserved, misc_frozen, fee_frozen}` (v7.4, `lib.rs:211`) → `{free, reserved, frozen, flags}` (v8). The indexer branches on neither.

---

### A7. `ControllerTransfer` is unhandled in `processUpdateReason` — CONFIRMED

**Location:** [`src/mappings/entities/assets/mapAsset.ts:545-584`](../../src/mappings/entities/assets/mapAsset.ts#L545)

`HoldingsUpdateReason` has four variants (`primitives/src/asset.rs:257-274` @ v8.0.0): `Issued`, `Redeemed`, `Transferred`, **`ControllerTransfer`**. The function branches on the first three and falls through to `{ eventId: undefined, assetDelta: {} }`.

Consequences:
- `asset.totalTransfers` is not incremented for controller transfers, though they are transfers.
- `eventId` is then resolved only by extrinsic call name — correct for a direct `controller_transfer` call, but falls back to the `Transfer` default when wrapped, so a batched controller transfer records the wrong event id.

Credit: raised in Francis's *One Movement Ledger* draft; independently verified here.

---

### A8. Two portfolio-movement events are in the enum but never registered — CONFIRMED history gap

`FungibleTokensMovedBetweenPortfolios` and `NFTsMovedBetweenPortfolios` exist in `schema.graphql:507-510` and `src/types/enums.ts:642/644`, are marked deprecated from 6.0.0, and are **not present in `project.ts` and not handled anywhere in `src/`**.

**Upgraded from "possible" to confirmed [V].** Both were declared *and emitted* at v5.4.3 in `unchecked_move_funds` (`pallets/portfolio/src/lib.rs:767, 781`), removed at v6.0.0:

```rust
FundDescription::Fungible { ticker, amount } => {
    Self::deposit_event(Event::FungibleTokensMovedBetweenPortfolios(
        origin_did, sender_portfolio, receiver_portfolio, ticker, amount, fund.memo));
}
FundDescription::NonFungible(nfts) => {
    Self::deposit_event(Event::NFTsMovedBetweenPortfolios(
        origin_did, sender_portfolio, receiver_portfolio, nfts, fund.memo))
}
```

They are **exclusive branches of a `match`, and `MovedBetweenPortfolios` is not emitted alongside them** — so v5-era movements through this path are absent from the index entirely, with no other event covering them.

Shapes differ: the fungible variant is 6 args, the NFT variant 5.

### Impact sized — negligible **[V]**

Counted against the public SubQuery dictionaries, both fully synced across all history (mainnet to block 25,337,651; testnet to 25,671,569):

| Event | Mainnet | Testnet |
|---|---|---|
| `FungibleTokensMovedBetweenPortfolios` | **0** | **0** |
| `NFTsMovedBetweenPortfolios` | **0** | **1** |
| `MovedBetweenPortfolios` (control) | 107 | 394 |
| `FundsMovedBetweenPortfolios` (control) | 12 | 539 |

The non-zero controls confirm the module/event naming is right, so the zeros are real rather than a query artefact.

The single testnet occurrence is block **7,786,536**, at spec version **5003001** — squarely in the v5 era, exactly where the code path predicted.

**Conclusion:** the code path was real, but essentially never exercised. **No mainnet history is missing.** Registering the two handlers is cheap insurance for testnet parity and completeness, not a data-correctness fix — see [`05-movement-ledger.md`](../implementation/05-movement-ledger.md). **Severity downgraded; this should sit near the bottom of the priority list.**

**[I]** Caveat: dictionaries index what their own project configures. Portfolio events are clearly covered (the controls are non-zero and the v5-era event was found), so this is sound, but it is one indexer's view rather than a direct chain scan.

---

### A11. `ChildIdentity` rows are stale from the v8 upgrade onward — CONFIRMED

**[V]** `v8.0.0:pallets/identity/src/migrations.rs`:

```rust
for (child_did, parent_did) in ParentDid::<T>::drain() {
    ChildDid::<T>::remove(&parent_did, &child_did);
}
log::info!("Child identities removed: {} items", reads);
```

The v8 upgrade **deleted every child identity in a storage migration** — a `drain()` plus `remove()`, emitting **no events**. `ChildDidCreated` / `ChildDidUnlinked` no longer exist in the v8 runtime at all.

The indexer therefore retains every pre-v8 `ChildIdentity` row indefinitely, asserting parent/child relationships the chain has deleted. Nothing in the current design can detect this, because detection would require noticing the *absence* of an event.

**Fix:** delete all `ChildIdentity` rows at the v8 upgrade boundary block, triggered from the proposed `ChainUpgrade` entity. This is the concrete instance of pattern P4 ("removed chain features leave orphaned state") in [`identity-asset-model.md`](./identity-asset-model.md) §3.

---

### A12. Claim id omits the issuer — CONFIRMED, silently wrong compliance answers

Full analysis in [`consumer-queries.md`](./consumer-queries.md) §3. Summary:

[`mapClaim.ts:43-61`](../../src/mappings/entities/identities/mapClaim.ts#L43) builds the id from `[target, claimType]` plus optional scope / jurisdiction / cddId — **not `issuer`** — and `handleClaimAdded` calls `Claim.create({ id })`, which overwrites. The SDK filters claims by `issuerId: { in: $trustedClaimIssuers }`.

- **Lost claim:** two trusted issuers attest the same type/scope for one target; the second overwrites the first, so a check against the first issuer matches nothing.
- **Spurious revocation:** one issuer revokes, `revokeDate` is set on the shared row, and the default `revokeDate: { isNull: true }` filter hides the *other* issuer's still-valid claim.

The only finding in this log that silently returns incorrect results to a compliance code path.

---

## B. Fragile patterns (not defects, but load-bearing luck)

### B1. `extract8xStakingAmount` uses a value-shape heuristic, not a version/type check

[`src/utils/common.ts:313-323`](../../src/utils/common.ts#L313) decides whether param 2 is an amount or a `RewardDestination` enum by regex-testing whether it is all digits.

It currently works, and it *also* silently rescues several 2-param 8.x balances events routed through `getBasicDetails` (`Burned`, `Slashed`, `Withdraw`, `Endowed`). But it is coincidence, not intent: any future `RewardDestination` variant rendering as a bare number misroutes the amount.

### B2. `getAssetIdForLegacyTicker` hardcodes a chain genesis hash

[`src/utils/assets.ts:87-111`](../../src/utils/assets.ts#L87) special-cases one staging chain by literal `chainId` string. Undocumented magic constant; silently produces wrong UUIDs if that chain is rebuilt or the situation recurs elsewhere.

### B3. `get8xStakingEventDetails` silent fallthrough

[`src/mappings/entities/events/mapStakingEvent.ts`](../../src/mappings/entities/events/mapStakingEvent.ts) returns `{ stashAccount }` with no `amount` for any 8.x staking event other than `Rewarded`/`Bonded`/`Unbonded`. Not currently reachable, but unlabelled.

### B4. `polymesh_private_dev` offsets unverified

The 2_000_000 / 2_001_000 / 2_002_000 thresholds are internally consistent (2.0 → 2.1 → 2.2) but were not cross-checked against the private chain's actual release spec versions.

### B5. Stale runner constraint

`project.ts:436` declares `node: { version: '>=3.0.1' }` while `package.json` pins `@subql/node ^6.4.6`.

### B6. Project metadata is unedited starter boilerplate

`project.ts:432-434`: `name: 'polkadot-starter'`, `description: 'This project can be used as a starting point for developing your SubQuery project'`, `version: '0.0.1'` (package.json is at `13.0.0`).

### B7. `spec_diffs/` in this repo is stale and misleading

Local `spec_diffs/` stops at `5003000-5003009`. The authoritative, current set lives in the `polymesh-types` repo and runs through `8000000-8999999`. Anyone consulting the local copy to reason about 6.x/7.x/8.x shapes gets nothing. Delete it or regenerate from `polymesh-types`.

### B8. Hand-written enum migrations have already shipped typos

`db/migrations/12_add_new_8_chain_events.sql` contains `after 'sumbit_unsigned'`, requiring a follow-up `16_rename_submit_unsigned.sql`. Symptom of the manual enum process described in the architecture review — the `alter type "<hashed-name>" add value ... after '<neighbour>'` form is unreviewable by eye and order-sensitive.

---

## C. Verified correct (do not re-investigate)

- `Withdrawn(AccountId, Balance)` and `Slash(AccountId, Balance)` **never** carried a DID at any version — the un-gated `handleBalanceAdded` path and its "not affected by 8x chain" comment are correct.
- `TreasuryReimbursement` 5.4.1 × 1.25 split; `TreasuryDisbursement` 5.0.0 target-address addition.
- Staking `Bonded`/`Unbonded`/`Rewarded` carried `IdentityId` through v7.4.0 (`pallets/staking/src/pallet/mod.rs`), dropped at 8.x.
- `Endowed`, `Reserved`/`Unreserved`, `ReserveRepatriated`, `AccountBalanceBurned`, `Deposit`/`Minted`.
- Asset-identifier resolution: all asset-touching handlers route through `getAssetId` / `getAssetIdWithTicker` / `getCaIdValue` / `getNftId` / `getExemptKeyValue`, which correctly branch on `is7xChain` for the ticker→assetId migration.
- `mapEvent.ts` generic serializer is metadata-driven (`genericEvent.meta.fields`), inherently version-agnostic.
- Confidential assets handlers (new in `7fbb8bb`) — single shape, no legacy concern.
- `mapTickers.ts` `TickerLinkedToAsset`/`TickerUnlinkedFromAsset` — 7.x-only events, fixed-shape read is correct.
- `mapSto.ts` `handleFundraiserOffchainFundingEnabled` — introduced at 7.3, no legacy shape.

---

## D. Improvement backlog

See [`../architecture-review.md`](../architecture-review.md) — covers the versioned decoder registry, metadata→enum codegen, entity merges/additions, index gaps, testing strategy, unused SubQuery features, and a sequenced roadmap.

---

## E. Open questions / not yet verified

- **Entity-by-entity version sweep is incomplete.** `PolyxTransaction` is fully swept against chain source v5.4.3→v8.0.2. Remaining entities (settlements, assets, NFTs, corporate actions, compliance, identities, portfolios, STOs, multisig, PIPs, external agents, confidential assets) have had a *static* review only — no line-by-line comparison against the Rust event definitions per tag. That sweep is the natural next chunk of work; `PolyxTransaction` took ~1 session and found 3 confirmed defects, so budget accordingly.
- `polymesh_private_dev` spec offsets (B4) — needs cross-check against the private chain's actual release history.
- `mapBridgeEvent.ts` — no version branching at all; likely fine (bridge struct is POLYX-only and orthogonal to the ticker/staking changes) but unverified against an early-chain `Bridged` encoding.
- Whether the middleware consumers actually query historical state — determines whether `--disable-historical` is a safe sync-speed win.
- Whether `store.getByFields` on `@subql/node` 6.x can replace the custom `getPaginatedData` helper.
