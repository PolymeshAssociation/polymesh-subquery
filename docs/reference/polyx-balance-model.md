# POLYX Balance Model — Ground-Up Redesign

**Goal:** for any account, at any block, return `free` / `reserved` / `frozen` / `spendable`, plus a complete, auditable trail of every POLYX movement that produced them.

Everything below marked **[V]** is verified against chain source or upstream package source; **[I]** is inference that needs a confirming query before being relied on.

---

## Part 1 — What the chain actually does

### 1.1 `AccountData` changed shape at v8

**[V]** `pallets/balances/src/lib.rs:211` @ v7.4.0:

```rust
pub struct AccountData {
    pub free: Balance,
    pub reserved: Balance,
    pub misc_frozen: Balance,  // floor on `free` for everything except tx fees
    pub fee_frozen: Balance,   // floor on `free` for tx fee payment
}
```

**[V]** `polymesh-types@feat/8.0.1-types` → `src/polkadot/types-lookup.ts:3661` (generated from chain 8.0.1):

```ts
interface PalletBalancesAccountData extends Struct {
  readonly free: u128;
  readonly reserved: u128;
  readonly frozen: u128;   // the two frozen fields merged
  readonly flags: u128;    // ExtraFlags (new-logic marker)
}
```

The indexer models neither shape and does not branch on this boundary at all.

### 1.2 There are three mechanisms, not one

This is the crux. POLYX is constrained by three *different* systems that the current schema flattens into one `BalanceTypeEnum`:

| Mechanism | Storage effect | Aggregation | Movable? |
|---|---|---|---|
| **Pools** — `free`, `reserved` | Actual balance fields | Sum of movements | **Yes** — value moves between them |
| **Locks / Freezes** — `misc_frozen`/`fee_frozen` (≤v7), `frozen` (v8) | A *floor* on `free` | **MAX across locks**, not sum | **No** — nothing moves |
| **Holds** (v8 only) — typed by `RuntimeHoldReason` | Backs `reserved` | Sum across holds | **Yes** — `free → reserved` |

**[V]** Pool movements, `pallets/balances/src/lib.rs` @ v7.4.0:
- `Reserved(who, v)` → `free -= v; reserved += v` (L1250–1261)
- `Unreserved(who, v)` → `reserved -= v; free += v` (L1278–1287)

**[V]** Lock identifiers pre-v8 — only two exist:
- `STAKING_ID = *b"staking "` (`pallets/staking/src/pallet/mod.rs:66`)
- `PIPS_LOCK_ID = *b"pips    "` (`pallets/pips/src/types.rs:43`)

**[V]** v8 hold reasons — `RuntimeHoldReason { Staking, Session, Preimage, Revive }` (`types-lookup.ts:4020-4030`).

### 1.3 The v7 → v8 staking inversion

This is the single most consequential finding in this document.

**[V] v7.4.0** — `pallets/staking/src/pallet/impls.rs:313` uses `LockableCurrency`:
```rust
T::Currency::set_lock(STAKING_ID, &stash, ...)
```
Bonding **moves no balance**. `free` is unchanged; `misc_frozen` rises.

**[V] v8** — staking is an upstream `fungible` Hold (`PalletStakingPalletHoldReason`, `types-lookup.ts:4032`).
Bonding **moves balance**: `free -= v; reserved += v`, emitting `balances.Held { reason: Staking, who, amount }`.

**Same event name `staking.Bonded`, opposite balance semantics.** The indexer treats both identically.

### 1.4 The complete v8 `balances` event surface

**[V]** from `types-lookup.ts:4009` — 31 variants:

```
Endowed · DustLost · Transfer · BalanceSet · Reserved · Unreserved · ReserveRepatriated
Deposit · Withdraw · Slashed · Minted · MintedCredit · Burned · BurnedDebt · Suspended
Restored · Upgraded · Issued · Rescinded · Locked · Unlocked · Frozen · Thawed
TotalIssuanceForced · Held · BurnedHeld · TransferOnHold · TransferAndHold · Released
Unexpected · TransferWithMemo
```

**[V]** Coverage audit against `project.ts` and `src/`:

| Event | In schema enum | In `project.ts` | Handled |
|---|---|---|---|
| `Held` | yes | **no** | **no** |
| `Released` | yes | **no** | **no** |
| `BurnedHeld` | yes | **no** | **no** |
| `TransferOnHold` | yes | **no** | **no** |
| `TransferAndHold` | yes | **no** | **no** |
| `MintedCredit` | yes | **no** | **no** |
| `BurnedDebt` | yes | **no** | **no** |
| `Unexpected` | yes | **no** | **no** |
| `DustLost` | yes | yes (`[]`) | **no** |
| `Thawed` | yes | yes (`[]`) | **no** |
| `Suspended` | yes | yes → `handleBalanceSuspended` | **no — function does not exist** |

**Consequence: on v8, the entire `reserved` mechanism is invisible to the indexer.** `Held`/`Released` are how reserved balance is created and destroyed, and neither is registered. Since v8 staking bonds via a Hold, bonded POLYX never appears in `reserved`.

`DustLost` is also a real, unindexed balance change — the account is reaped and its remaining free balance is destroyed.

---

## Part 2 — Why the current model cannot work

Beyond the coverage gaps, the model has four structural faults. Each is independently fatal to "balance at any block".

**F1 — One `type` column for a two-sided movement.** Every movement has a source pool and a destination pool, and they differ (`Reserved` is `Free → Reserved`). A single `type` can only ever record half.

**F2 — `frozen` is a MAX, not a SUM.** `frozen = max(all active locks)`. Two overlapping locks of 100 and 150 yield `frozen = 150`, not 250. **No amount of summing movement rows can produce a max.** Representing locks as ledger rows (`type: Locked`) is not merely imprecise, it is mathematically incapable of yielding the right answer. Locks need per-lock state, keyed by `(account, lockId)`.

**F3 — `BalanceSet` is absolute, recorded as a delta.** It *sets* `free` (and pre-v8 `reserved`) to a value. Treating it as a movement corrupts any running total from that point on. It must be a **reset checkpoint**.

**F4 — `BalanceTypeEnum` conflates all three mechanisms.** `Free`/`Reserved` are pools; `Locked` is a floor; `Bonded`/`Unbonded` are staking-ledger states whose *underlying mechanism inverted at v8* (§1.3). Summing by `type` produces a number with no on-chain referent.

Plus the already-filed defects: `staking.Withdrawn` recorded as a **credit** to `Unbonded` when it drains the queue (audit A6), and `BalanceSet` reading `params[4]` instead of `params[3]` (audit A1).

---

## Part 3 — The design

Four structures, each doing one job.

### 3.1 `PolyxMovement` — append-only double-entry ledger

One row per balance movement. Immutable; never updated after write.

```graphql
type PolyxMovement @entity {
  id: ID!                          # blockId/eventIdx[/subIdx]

  "source; null = value entered the system (mint, endow, reward)"
  fromAddress: String @index
  fromPool: PolyxPool
  "destination; null = value left the system (burn, slash, fee, dust)"
  toAddress: String @index
  toPool: PolyxPool

  amount: BigInt!
  "set when from/toPool is Reserved on a v8 chain"
  holdReason: HoldReason

  kind: MovementKind!              # semantic classification, not mechanism
  memo: String
  fromIdentity: Identity
  toIdentity: Identity

  eventId: EventIdEnum!
  moduleId: ModuleIdEnum!
  extrinsic: Extrinsic
  eventIdx: Int!
  datetime: Date!
  createdBlock: Block!
}

enum PolyxPool { Free, Reserved }   # ONLY real pools

enum HoldReason { Staking, Session, Preimage, Revive, Unknown }

enum MovementKind {
  Transfer, Endowment, Fee, Tip, TreasuryDisbursement, TreasuryReimbursement,
  StakingReward, Bond, Unbond, WithdrawUnbonded, Slash, Mint, Burn,
  DustLost, ReserveRepatriation, Hold, Release, BalanceSetAdjustment
}
```

`PolyxPool` deliberately has **two** members. `Bonded`/`Unbonded`/`Locked` are not pools and must not appear here — they are expressed via `holdReason` (v8) or the lock table (§3.3).

### 3.2 `AccountBalance` — current state, time-travel for free

**[V]** `@subql/node-core/dist/configure/NodeConfig.js:29` sets `historical: 'height'` **by default**, and `docker-compose.yml` leaves `--disable-historical` commented out. SubQuery therefore already versions every entity row by block range and exposes a `blockHeight` argument on GraphQL queries.

**This means the "balance at any block" requirement needs no snapshot table.** Maintain current balance as an ordinary mutable entity and SubQuery time-travels it:

```graphql
type AccountBalance @entity {
  id: ID!              # address
  account: Account!
  free: BigInt!
  reserved: BigInt!
  "MAX over active locks/freezes — maintained from BalanceLock, never summed"
  frozen: BigInt!
  "free + reserved"
  total: BigInt!
  "free - frozen, floored at 0; the practically transferable amount"
  spendable: BigInt!
  updatedBlock: Block!
}
```

Query:
```graphql
{ accountBalance(id: "5Gr...", blockHeight: "9482013") { free reserved frozen spendable } }
```

Two consequences worth stating plainly:
- Historical tracking is what makes this work, so **`--disable-historical` must not be enabled** on this project — the write-amplification saving I floated in the architecture review is off the table if this design is adopted. That tradeoff is now decided by a hard requirement.
- Correctness depends on every mutation being applied. Hence §3.4.

### 3.3 `BalanceLock` and `BalanceHold` — constraint state

Required because of F2: locks aggregate by max, so each must be tracked individually.

```graphql
"Pre-v8 locks (staking, pips) and v8 freezes. A floor on free — NOT a pool."
type BalanceLock @entity {
  id: ID!                # address/lockId
  account: Account!
  lockId: String!        # "staking ", "pips    ", or v8 freeze id
  amount: BigInt!
  reasons: String        # WithdrawReasons bitfield
  active: Boolean!
  updatedBlock: Block!
}

"v8 only. Typed reservations that DO move balance into `reserved`."
type BalanceHold @entity {
  id: ID!                # address/reason
  account: Account!
  reason: HoldReason!
  amount: BigInt!
  updatedBlock: Block!
}
```

Then, maintained on every relevant event:
- `AccountBalance.frozen = MAX(BalanceLock.amount WHERE active)` — pre-v8, computed separately for misc vs fee if that precision is needed
- `AccountBalance.reserved = SUM(BalanceHold.amount)` on v8; on ≤v7 it comes from `Reserved`/`Unreserved`/`ReserveRepatriated` movements

### 3.4 `BalanceReconciliation` — drift detection

Event-sourced balances drift if any mutation lacks an event or a handler is wrong — exactly the failure this whole audit is about. **[I]** Substrate does not guarantee an event for every balance mutation, so the ledger must be checked against authoritative state rather than trusted.

Because the global `api` inside a handler is block-scoped (verified in audit A5), a handler can query authoritative state for the block it is indexing:

```ts
const onChain = await api.query.system.account(address);   // scoped to this block
```

Sampling strategy — cheap enough to run continuously:
- every Nth block, for accounts touched in that block, compare derived vs on-chain
- always reconcile after `BalanceSet` (F3) and `DustLost`
- on mismatch: write a `BalanceReconciliation` row with both values and the delta, and **correct the derived balance to the on-chain value** so drift cannot compound

```graphql
type BalanceReconciliation @entity {
  id: ID!
  account: Account! @index
  derivedFree: BigInt!
  onChainFree: BigInt!
  derivedReserved: BigInt!
  onChainReserved: BigInt!
  delta: BigInt!
  block: Block!
}
```

This turns a silent-corruption class into a queryable defect list, and doubles as the acceptance test for the migration.

---

## Part 4 — Event → movement mapping

Both eras, from the verified semantics in Part 1. `∅` = outside the system.

### 4.1 Pool movements — pre-v8 (Polymesh custom pallet)

| Event | from | to | Kind |
|---|---|---|---|
| `Endowed(did, who, v)` | ∅ | `who/Free` | Endowment |
| `Transfer(fromDid, from, toDid, to, v, memo?)` | `from/Free` | `to/Free` | Transfer |
| `Reserved(who, v)` | `who/Free` | `who/Reserved` | Hold |
| `Unreserved(who, v)` | `who/Reserved` | `who/Free` | Release |
| `ReserveRepatriated(from, to, v, status)` | `from/Reserved` | `to/Free`\|`to/Reserved` per status | ReserveRepatriation |
| `AccountBalanceBurned(did, who, v)` | `who/Free` | ∅ | Burn |
| `BalanceSet(did, who, free, reserved)` | — | — | **checkpoint, not a movement** (F3) |
| `treasury.TreasuryDisbursement` | treasury`/Free` | `to/Free` | TreasuryDisbursement |
| `protocolfee.FeeCharged`, `transactionpayment.TransactionFeePaid` | `who/Free` | ∅ | Fee |
| `staking.Rewarded/Reward` | ∅ | `stash/Free` | StakingReward |
| `staking.Slashed/Slash` | `staker/Free` | ∅ | Slash |

### 4.2 Lock changes — pre-v8 (no movement rows)

`staking.Bonded` / `Unbonded` / `Withdrawn` and PIPs vote lock/unlock update **`BalanceLock` only**. `free` does not change.

This is the correction to audit A6: pre-v8 these must not produce `PolyxMovement` rows at all. The existing `type: Bonded` rows assert movements that never happened.

### 4.3 Pool movements — v8 (upstream pallet)

| Event | from | to | Kind |
|---|---|---|---|
| `Transfer{from,to,amount}` | `from/Free` | `to/Free` | Transfer |
| `TransferWithMemo{...}` | — | — | **memo enrichment of the paired `Transfer`; not a second movement** |
| `Endowed{account,freeBalance}` | ∅ | `account/Free` | Endowment |
| `Held{reason,who,amount}` | `who/Free` | `who/Reserved` | Hold |
| `Released{reason,who,amount}` | `who/Reserved` | `who/Free` | Release |
| `BurnedHeld{reason,who,amount}` | `who/Reserved` | ∅ | Slash |
| `TransferOnHold{reason,source,dest,amount}` | `source/Reserved` | `dest/Reserved` | ReserveRepatriation |
| `TransferAndHold{reason,source,dest,transferred}` | `source/Free` | `dest/Reserved` | ReserveRepatriation |
| `Reserved` / `Unreserved` / `ReserveRepatriated` | as pre-v8 | | |
| `Minted` / `Deposit` / `Restored` | ∅ | `who/Free` | Mint |
| `Burned` / `Slashed` / `Withdraw` / `Suspended` | `who/Free` | ∅ | Burn / Slash |
| `DustLost{account,amount}` | `account/Free` | ∅ | DustLost |
| `BalanceSet{who,free}` | — | — | checkpoint |
| `Issued` / `Rescinded` / `TotalIssuanceForced` / `MintedCredit` / `BurnedDebt` | — | — | **total-issuance only, no account side** — track on a separate `TotalIssuance` entity, not the account ledger |
| `Locked` / `Unlocked` / `Frozen` / `Thawed` | — | — | `BalanceLock` only, no movement |
| `Upgraded{who}` | — | — | no amount; account flag migration only |

### 4.4 v8 staking

`staking.Bonded` / `Unbonded` / `Withdrawn` become **staking-ledger state**, not movements — the balance effect arrives separately via `Held` / `Released`. Keeping both would double count.

This resolves the A6 `Withdrawn` bug structurally: it is no longer a credit to a fictional `Unbonded` pool, it is a staking-ledger transition whose balance effect is the paired `Released`.

**[I]** The exact pairing of `staking.Bonded` with `balances.Held{reason:Staking}` within one extrinsic should be confirmed against a real v8 block before relying on it for backfill.

---

## Part 5 — Migration path

Additive first; nothing breaks until the final step.

**Phase 1 — build alongside (non-breaking).**
Add `PolyxMovement`, `AccountBalance`, `BalanceLock`, `BalanceHold`, `BalanceReconciliation`. Register the 8 unhandled v8 events (§1.4). Keep writing `PolyxTransaction` exactly as today. Run reconciliation and drive mismatches to zero — this is the correctness gate, and it is measurable rather than a matter of opinion.

**Phase 2 — dual-read.** Point new consumers at `AccountBalance` / `PolyxMovement`. Deprecate `PolyxTransaction` in its schema docstring.

**Phase 3 — remove (next major).** Drop `PolyxTransaction` and `BalanceTypeEnum`.

### Fix independently of the redesign

These are wrong under the current schema and shouldn't wait:
1. `BalanceSet` → `params[3]` (audit A1)
2. `staking.Withdrawn` direction (audit A6)
3. `handleBalanceSuspended` missing (audit A3)
4. `TransferWithMemo` double-write / 7.4 misdecode (audit A2)
5. Register `Held`/`Released` at minimum — without them v8 `reserved` is simply absent

---

## Open questions

1. **Does every balance mutation emit an event on Polymesh?** Determines whether reconciliation is a safety net or a load-bearing component. Settle empirically via Phase 1 mismatch rates.
2. **Is per-lock precision needed pre-v8** (`misc_frozen` vs `fee_frozen` tracked separately), or is a single `frozen = max(all locks)` sufficient for consumers?
3. **Genesis balances** — currently seeded by `genesisHandler`. Must feed the opening checkpoint, or every derived balance is off by the genesis allocation.
4. **PIPs vote locks** — `PIPS_LOCK_ID` locks are entirely unmodelled today. In scope?
5. **Reconciliation sampling rate** — every Nth block vs every touched account. Pure cost/confidence tradeoff; measure in Phase 1.

---

# Part 6 — Requirements from Subscan parity

Observed directly from `polymesh-testnet.subscan.io` for account `5Df9Yd…RHg5vV` **[V]**:

**Balance panel** decomposes the holding into three *user-facing* buckets, not raw chain fields:

| Subscan label | Underlying |
|---|---|
| **Transferable** | `free − frozen`, floored at 0 |
| **Staking** | bonded — pre-v8: the `"staking "` lock; v8: hold with `reason = Staking` |
| **Others** | everything else reserved/frozen — pre-v8: other locks (`"pips    "`); v8: holds with other reasons |

Note this decomposition is **era-dependent** — the same "Staking" number comes from a lock pre-v8 and a hold on v8 (§1.3). Any implementation must branch here.

**Two tab counts that differ, and the difference is the design point:** `Extrinsics (116)` vs `Transfers (231)`.

- *Extrinsics* = extrinsics **signed by** this account.
- *Transfers* = movements **touching** this account, in either direction — the account appears in both the From and To columns of the same list.

These are two different query axes over two different things, and an account's transfer count exceeding its extrinsic count is normal (incoming transfers it never signed). Columns: `Index · Block · From · To · Value · Time · Result`.

**Balance History** is a first-class tab: a time-series of the balance with downloadable data — i.e. point-in-time balance is expected to be cheap and bulk-exportable, not a per-block reconstruction.

### What that implies

1. The ledger must be queryable as **"every movement touching account X"** in one indexed scan — not an `OR` across two columns.
2. Point-in-time balance must be cheap in **bulk** (chart, CSV export), not just for a single block.
3. The three-bucket decomposition must be derivable without a join per row.
4. Fee-paying, rewards, and transfers must all be distinguishable — "how POLYX was spent" needs a semantic classification, not just a delta.

---

# Part 7 — Minimal-entity design (supersedes Part 3)

Part 3 proposed four new entities. Working through the Subscan requirements, that collapses to **two**, because per-lock and per-hold state are better expressed as versioned `@jsonField` arrays than as separate tables, and reconciliation folds into the `IndexerAnomaly` entity already proposed in the architecture review.

Net entity change: **+2 new, −1 removed (`PolyxTransaction`) = +1 overall.**

### 7.1 Entry-centric, not movement-centric

The decisive question is whether the ledger stores one row per *movement* (with `from`/`to`) or one row per *account-side*.

Requirement 1 above settles it. Movement-centric forces `WHERE fromAddress = X OR toAddress = X`, which is an OR across two indexes and paginates badly — exactly the Subscan "Transfers" query, the single most-used view.

The usual objection is row-count doubling. **It doesn't double here**, because most POLYX movements are single-sided:

| Movement class | Account sides | Frequency |
|---|---|---|
| Fees (`TransactionFeePaid`, `FeeCharged`) | 1 | every signed extrinsic — dominates by count |
| Rewards, mints, burns, slashes, `DustLost` | 1 | common |
| Holds/releases (`Held`, `Released`, `Reserved`, `Unreserved`) | 1 account, 2 pools | common |
| Transfers, `ReserveRepatriated`, `TransferOnHold`, `TransferAndHold` | 2 | minority |

Only the last row doubles.

### Measured on live chains — 1.03×, not 1.2–1.3× **[V]**

Counted against the production middleware endpoints (mainnet synced to 25,337,697; testnet to 25,671,622):

| | Mainnet | Testnet |
|---|---|---|
| `polyxTransactions` rows | 4,998,600 | 1,673,479 |
| Both sides populated (→ 2 entries) | 174,216 (3.5%) | 10,192 (0.6%) |
| One side only (→ 1 entry) | 4,824,384 | 1,663,287 |
| **Resulting entries** | **5,172,816** | **1,683,671** |
| **Amplification** | **1.035×** | **1.006×** |

My earlier estimate was 4–8× too pessimistic. The reason is visible in the event mix: **staking rewards are 61% of all mainnet rows** (`Reward` 1,697,946 + `Rewarded` 1,362,878 = 3,060,824), and rewards are single-sided credits. Transfers — the only high-volume two-sided movement — are just 141,516.

**The row-count objection to entry-centric storage does not survive contact with the data.** A 3.5% increase buys a single indexed lookup in place of an `OR` across two columns on the most common query in both consumers.

Entry-centric also unlocks the killer feature: storing **balance-after** on each entry makes Balance History a pure index scan with zero aggregation, and gives a second, independent way to answer point-in-time balance.

### 7.2 `PolyxEntry` — the one ledger table

```graphql
"""
One row per (account, movement side). Append-only; never updated after write.
Sibling entries of the same on-chain movement share `movementId`.
"""
type PolyxEntry @entity {
  id: ID!                        # blockId/eventIdx/side

  "groups the sides of one movement; join on this to see the counterparty"
  movementId: String! @index

  account: Account!              # indexed FK — the account page query
  identity: Identity

  "which pool moved. Free or Reserved only — never a lock/ledger state"
  pool: PolyxPool!
  "signed: negative = debit, positive = credit. SUM(amount) = net delta"
  amount: BigInt!

  "the other side, denormalised so the transfer list needs no join"
  counterpartyAddress: String @index
  counterpartyIdentity: Identity

  kind: MovementKind!            # Fee, Transfer, StakingReward, Bond, Slash, …
  holdReason: HoldReason         # set when pool = Reserved on v8
  memo: String

  "balance snapshots AFTER this entry — powers Balance History with no aggregation"
  freeAfter: BigInt!
  reservedAfter: BigInt!
  frozenAfter: BigInt!

  event: Event!
  extrinsic: Extrinsic           # null for events with no extrinsic
  eventIdx: Int!
  datetime: Date!
  createdBlock: Block!
}
```

Serving the Subscan views:

| View | Query |
|---|---|
| Transfers tab | `PolyxEntry(account = X, kind = Transfer) ORDER BY block DESC` — one index |
| Balance History | `PolyxEntry(account = X) { datetime freeAfter reservedAfter frozenAfter }` — no aggregation |
| "How POLYX was spent" | `GROUP BY kind, SUM(amount) WHERE account = X` |
| Extrinsics tab | **not this table** — `Extrinsic(address = X)`; this is why the two counts differ |

Composite indexes: `(accountId, createdBlockId)`, `(accountId, kind)`, `(movementId)`.

### 7.3 `AccountBalance` — current state, with locks inline

```graphql
type AccountBalance @entity {
  id: ID!                        # address
  account: Account!
  identity: Identity @index

  free: BigInt!
  reserved: BigInt!
  "MAX over active locks — maintained from `locks`, never summed"
  frozen: BigInt!
  total: BigInt!                 # free + reserved

  "Subscan-equivalent derived buckets, materialised to avoid per-row computation"
  transferable: BigInt!          # free - frozen, floored at 0
  bonded: BigInt!                # staking lock (pre-v8) or Staking hold (v8)
  otherReserved: BigInt!         # reserved/frozen not attributable to staking

  "per-lock detail — needed because frozen is a MAX, not a SUM"
  locks: [LockEntry]
  "v8 only; SUM of these = reserved"
  holds: [HoldEntry]

  updatedBlock: Block!
}

type LockEntry @jsonField { lockId: String!, amount: BigInt!, reasons: String }
type HoldEntry @jsonField { reason: HoldReason!, amount: BigInt! }
```

Keeping `locks`/`holds` as jsonFields rather than tables preserves the per-lock precision that F2 demands, versions them automatically with the row, and avoids two joins on the hottest read path. The tradeoff, stated plainly: you lose the ability to efficiently ask *"which accounts hold a staking lock above N"* across all accounts. **[I]** That appears to be a rare analytics query rather than a product surface — worth confirming with consumers before locking this in; if it matters, `BalanceHold` goes back to being its own table.

### 7.4 Two independent time-travel mechanisms

Worth calling out because it is unusual and it is a robustness win:

1. **`AccountBalance` + SubQuery historical** (`historical: 'height'` is the default, **[V]** `NodeConfig.js:29`) → `accountBalance(id: X, blockHeight: N)`. Best for "balance of these 500 accounts at block N".
2. **`PolyxEntry.freeAfter`** → last entry at or before block N. Best for charts and CSV export, and it does **not** depend on SubQuery's historical feature at all.

They should agree. Where they disagree, that is a defect signal — a free continuous cross-check on top of the storage reconciliation in §3.4.

### 7.5 Entity count, before and after

| | Entities |
|---|---|
| Today | `PolyxTransaction` |
| Part 3 sketch | `PolyxMovement`, `AccountBalance`, `BalanceLock`, `BalanceHold`, `BalanceReconciliation` (+5, −1) |
| **Part 7** | **`PolyxEntry`, `AccountBalance`** (+2, −1); locks/holds inline as jsonFields; reconciliation reuses `IndexerAnomaly` |

Everything links through existing entities — `Account`, `Identity`, `Event`, `Extrinsic`, `Block` — so no new relation hubs are introduced.

### 7.6 Additional open questions for review (continued in §8.7)

6. **Row amplification** — confirm the ~1.2–1.3× estimate in §7.1 against a real block range before committing to entry-centric.
7. **Is the cross-account lock query needed?** (§7.3) Decides jsonField vs. table for holds.
8. **`balanceAfter` on every entry** costs three BigInts per row. Cheap insurance, or unnecessary denormalisation given mechanism 1 already exists?
9. **Sub-entry ordering within a block** — several movements can share an `eventIdx` (e.g. a fee plus its treasury split). The `id` scheme needs a deterministic side/sub-index so `freeAfter` is unambiguous.
10. **Does "Transfers" mean `kind = Transfer` only**, or all value movement? Subscan's 231-vs-116 split suggests transfers only, but the filter definition should be agreed with consumers rather than assumed.

---

# Part 8 — Designing for aggregation

The requirement is that consumers can `sum` / `average` / group POLYX data in GraphQL directly, while every individual movement stays queryable. The good news: **the stack already supports this.** What is missing is a schema that exposes the right dimensions to aggregate over.

## 8.1 Confirmed capability

Verified by inspecting the deployed query image `onfinality/subql-query:v2.25.0` **[V]**:

- `@graphile/pg-aggregates` is bundled (`node_modules/@graphile/pg-aggregates`).
- The `aggregate` CLI flag is **`default: true`** (`dist/yargs.js:18-22`) — aggregation is on right now, without any config change.
- SubQuery ships a *patched* fork of the plugin (`dist/graphql/plugins/PgAggregateSpecsPlugin.js`) whose header states it exists to fix *"type conversion causes precision loss"*, casting results `::text`. **This is the BigInt-precision fix** — POLYX sums will not lose precision and come back as strings.

Available aggregate functions **[V]** (`id:` entries in the specs plugin):

`sum` · `average` · `min` · `max` · `distinctCount` · `stddevPopulation` · `stddevSample` · `variancePopulation` · `varianceSample`

## 8.2 The one hard constraint

`dist/graphql/plugins/PgAggregationPlugin.js:26` **[V]**:

```js
const pgAggregateGroupBySpecs = [];
```

The plugin loads `AddGroupByAggregateEnumValuesForColumnsPlugin` but registers **no derived group-by specs**. Two consequences, and they drive the entire schema design:

1. **You can only `groupBy` a plain column** (scalars and enums included).
2. **You cannot `groupBy` a derived expression** — in particular *there is no timestamp truncation*. `groupBy: [DATE_TRUNC_DAY]` does not exist.

And from Postgraphile generally: **aggregation does not traverse relations**. You cannot group `PolyxEntry` by `event.moduleId`.

> **Design rule:** every dimension anyone may want to group by must exist as a *materialised scalar column on the row itself* — including time buckets, and including values that are trivially derivable.

This is why the entry table carries denormalised columns that look redundant. They are not redundant; they are the only way the grouping works.

## 8.3 Dimensions and measures on `PolyxEntry`

Added to the Part 7 definition:

```graphql
type PolyxEntry @entity {
  # ---------- measures ----------
  "signed: negative = debit, positive = credit. SUM = net balance change"
  amount: BigInt!
  "unsigned. SUM = gross volume moved, regardless of direction"
  amountAbs: BigInt!
  "balance snapshots after this entry — also aggregatable: AVERAGE(freeAfter)
   over a period is average balance held; MIN/MAX give the range"
  freeAfter: BigInt!
  reservedAfter: BigInt!
  frozenAfter: BigInt!

  # ---------- dimensions (all materialised; none reachable via join) ----------
  account: Account!              # FK column, groupable
  identity: Identity
  counterpartyAddress: String
  counterpartyIdentity: Identity

  kind: MovementKind!            # Fee, Transfer, StakingReward, Bond, Slash, …
  "materialised even though derivable from sign(amount) — expressions are not groupable"
  direction: EntryDirection!     # Debit | Credit
  pool: PolyxPool!
  holdReason: HoldReason

  "denormalised from the extrinsic: 'which pallet/call spent this POLYX'"
  moduleId: ModuleIdEnum
  callId: CallIdEnum
  eventId: EventIdEnum!

  "materialised time buckets — REQUIRED, no date_trunc grouping exists"
  date: Date!                    # day granularity
  monthId: String!               # 'YYYY-MM'
  "spec version at this block — makes era-over-era analysis a groupBy"
  specVersionId: Int!
  "staking era, when applicable — reward/slash analysis"
  eraIndex: Int
}

enum EntryDirection { Debit, Credit }
```

`amount` and `amountAbs` are both carried deliberately: `SUM(amount)` answers *"what was the net change"*, `SUM(amountAbs)` answers *"how much moved"*. Neither derives from the other under aggregation, since sign cannot be applied inside a `sum`.

## 8.4 What this makes possible

All of these run against the live schema with no rollup table and no post-processing:

**How this account spent POLYX, by category**
```graphql
polyxEntries(filter: {
  accountId: { equalTo: "5Df9…" }, direction: { equalTo: DEBIT }
}) {
  groupedAggregates(groupBy: [KIND]) {
    keys
    sum { amountAbs }
    average { amountAbs }
    distinctCount { movementId }
  }
}
```

**Which calls cost this account the most in fees**
```graphql
polyxEntries(filter: { accountId: {equalTo: "5Df9…"}, kind: {equalTo: FEE} }) {
  groupedAggregates(groupBy: [CALL_ID]) { keys sum { amountAbs } average { amountAbs } }
}
```

**Daily transfer volume** — works only because `date` is a column
```graphql
polyxEntries(filter: { kind: { equalTo: TRANSFER } }) {
  groupedAggregates(groupBy: [DATE]) { keys sum { amountAbs } distinctCount { movementId } }
}
```

**Staking rewards per era**
```graphql
polyxEntries(filter: { kind: { equalTo: STAKING_REWARD } }) {
  groupedAggregates(groupBy: [ERA_INDEX]) { keys sum { amount } average { amount } }
}
```

**Average balance held over a period** — the payoff from `freeAfter`
```graphql
polyxEntries(filter: {
  accountId: {equalTo: "5Df9…"}, date: {greaterThan: "2026-01-01"}
}) {
  aggregates { average { freeAfter } min { freeAfter } max { freeAfter } }
}
```

Note `distinctCount { movementId }` throughout: it counts *movements*, correcting for the entry-per-side split from §7.1. Without it, a transfer would count twice.

## 8.5 Where rollups are still needed

Live aggregation is not free — `groupedAggregates` scans the filtered set. Rough guidance:

| Query shape | Live aggregate? |
|---|---|
| Account-scoped, any range (`accountId` filter) | **Yes** — bounded by one account's history |
| Kind- or call-scoped over months | **Yes**, with a date filter |
| Whole-chain daily series over years | **No** — pre-aggregate |

So a small `DailyPolyxStat { date, kind, totalVolume, netChange, movementCount, activeAccounts }` rollup remains worthwhile for chain-wide dashboards, written incrementally per block. Everything account-scoped — which is the Subscan use case — needs no rollup.

**[I]** The crossover point should be measured on real data rather than guessed; it depends on row counts and hardware.

## 8.6 Indexes and safety

Aggregates are only as fast as the **filter** that precedes them (grouping itself is a hash over the filtered rows). Composite indexes should follow the filter combinations above, not the groupBy columns:

- `(accountId, date)` — account activity over time
- `(accountId, kind)` — spend breakdown
- `(kind, date)` — chain-wide series
- `(movementId)` — sibling lookup

Two safety notes for review:

- An **unfiltered** `groupedAggregates` over the largest table in the database will attempt a full scan. **Confirmed empirically [V]:** `polyxTransactions { groupedAggregates(groupBy: [EVENT_ID]) }` against mainnet (5M rows) returns `canceling statement due to statement timeout` (Postgres `57014`). The production endpoint already has a statement timeout, which is the right mitigation — but it means unfiltered aggregates are unusable, not merely slow, so consumers must always filter. Targeted `totalCount` queries on the same table return instantly.
- Row width grows by ~10 columns on the highest-volume table. That is a real storage and write cost, accepted deliberately in exchange for join-free aggregation — it should be quantified during Phase 1 rather than assumed acceptable.

## 8.7 Open questions (continuing from §7.6)

11. **Which time buckets to materialise?** `date` alone, or also `monthId` / `weekId`? Each is a column on the biggest table; adding them later is a migration.
12. **Is `eraIndex` resolvable at index time** for every staking entry, or does it require a lookup that slows the hot path?
13. **Should `amountAbs` exist**, or should consumers filter by `direction` and negate? Two BigInts per row vs. more awkward queries.
14. ~~**Fiat valuation**~~ — **RESOLVED: out of scope for v1 (D7).** No `valueUsd` column, no `PolyxPrice` entity.

    Rationale, recorded for whoever revisits this. Because pg-aggregates cannot traverse relations (§8b), USD sums require the value **on the row** — a joined price table can display a single row's worth but cannot `SUM` in GraphQL. So the capability is only obtainable via a per-entry `valueUsd`, populated at index time.

    Two reasons not to: no consumer queries anything fiat-denominated today **[V]**, and it would introduce an **external oracle dependency** into an index whose every number is currently reproducible from chain state alone. Two resyncs could produce different `valueUsd` if the price source revises its history.

    **Cost of the decision:** adding it later means backfilling one column across the whole ledger. That is a well-understood, mechanical backfill — not a design problem — which is what makes deferring it safe.
15. **Query-service hardening** — should `--aggregate` stay on for the public endpoint without a cost limiter? It is on by default today, already, on the current schema.

---

# Part 9 — Pre-computed summaries alongside the detail

The proposal: keep the full `PolyxEntry` detail *and* maintain summed entities, so common totals are read rather than recomputed. Sound instinct — but in SubQuery the cost of a rollup depends entirely on its **key cardinality per block**, and that produces a sharp three-tier split. Some rollups are free, some are cheap, and one common shape is actively pathological.

## 9.1 The mechanic that decides everything

With historical mode on (default, §3.2), updating an entity does not overwrite a row — it closes the previous version's block range and inserts a new one **[V]** (`cacheModel.js:334-351`, an `UPDATE … SET _block_range` followed by the insert).

The saving grace, **[V]** `setValueModel.js:20-28`:

```js
set(data, blockHeight, operationIndex) {
    const latestIndex = this.latestIndex();
    if (latestIndex >= 0) {
        // Set multiple time within same block, replace with input data only
        if (this.historicalValues[latestIndex].startHeight === blockHeight) {
            this.historicalValues[latestIndex].data = data;
            …
```

Multiple writes to the same entity **within one block coalesce into a single version**.

> **Cost rule:** a rollup row costs **one row version per block in which its key is touched** — not one per update.

So the question for any proposed rollup is never "how many movements feed it" but **"in how many distinct blocks does this key change?"**

## 9.2 Cost by grain

At ~6s blocks (~14,400 blocks/day) **[I]** — orders of magnitude, not precise figures:

| Rollup grain | Blocks touching a given key | Versions/day per key | Verdict |
|---|---|---|---|
| Lifetime totals **on `AccountBalance`** | row is already written on those blocks | **0 extra** | **Free** |
| `AccountPolyxDaily` (account × day) | few — an account is active in a handful of blocks | ~1–10 | **Cheap** |
| `AssetPolyxDaily` / per-era staking | low per key | low | Cheap |
| **Chain-wide daily totals** (single row per day) | **potentially every block** | **up to 14,400** | **Pathological** |

The last row is the trap. A global counter is touched by every movement on the chain, so it takes a new version nearly every block — roughly **5M row versions per year for one logical counter**, which is worse than aggregating the detail table it was meant to accelerate.

## 9.3 Tier 1 — free: lifetime totals on `AccountBalance`

`AccountBalance` is *already* rewritten on every block that touches the account. Adding running totals to that same row costs **no additional versions at all**:

```graphql
type AccountBalance @entity {
  # … balance fields from §7.3 …

  "lifetime running totals — free, because this row is already versioned on these blocks"
  totalReceived: BigInt!
  totalSent: BigInt!
  totalFeesPaid: BigInt!
  totalRewards: BigInt!
  totalSlashed: BigInt!
  movementCount: Int!
  firstActiveBlock: Block!
  lastActiveBlock: Block!

  "pre-summed per-category breakdown; read directly, never recomputed"
  lifetimeByKind: [KindTotal]
}

type KindTotal @jsonField {
  kind: MovementKind!
  totalAbs: BigInt!
  net: BigInt!
  count: Int!
}
```

This alone answers most of what an account page needs — total in/out, fees paid, rewards earned, spend by category — as a **single row read**, no aggregation.

The `lifetimeByKind` jsonField deliberately trades groupability for cost: you cannot `groupBy` inside a jsonField, but you never need to, because it is already summed. Ad-hoc slicing still goes to `PolyxEntry` via pg-aggregates (§8). The two mechanisms cover different needs and neither duplicates the other's work.

## 9.4 Tier 2 — cheap: per-account period rollups

For time series without scanning entries:

```graphql
type AccountPolyxDaily @entity {
  id: ID!                  # address/YYYY-MM-DD
  account: Account! 
  date: Date!

  openingFree: BigInt!
  closingFree: BigInt!
  closingReserved: BigInt!
  closingFrozen: BigInt!

  received: BigInt!
  sent: BigInt!
  feesPaid: BigInt!
  rewards: BigInt!
  netChange: BigInt!
  movementCount: Int!
}
```

Composite index `(accountId, date)`. Cheap because a single account changes in few blocks per day, and it makes multi-year account charts a bounded index scan.

**[I]** Whether this is needed at all depends on how well `PolyxEntry.freeAfter` (§7.2) already serves charting — that path needs no aggregation either. Worth measuring before building; it may be redundant.

## 9.5 Tier 3 — chain-wide totals: do *not* make it an updated entity

Three viable options, in preference order:

1. **Live aggregation with a date filter** (§8). `groupedAggregates(groupBy: [DATE])` over a bounded range. No storage cost, no versioning. Suitable for dashboards querying months, not years.
2. **Compute outside the indexer** — a scheduled job or materialised view over finalised blocks only. Sidesteps historical entirely, but **must handle reorgs itself**; safest is to lag behind the finalised head and recompute the trailing window.
3. **Shard the key so it is not a singleton** — e.g. `date × kind` instead of `date` alone. Splits updates across rows and cuts per-row version counts proportionally. A partial mitigation, not a fix.

What to avoid: a single `DailyStat` row incremented on every movement. It is the intuitive design and it is the one that degrades worst.

## 9.6 Reorgs — an argument for staying inside SubQuery

Rollups maintained as entities in handlers are **reorg-safe for free**: historical mode rewinds by block range, so counters revert with everything else.

Rollups computed as Postgres triggers or materialised views are **not** — they have no notion of a chain rewind and will silently retain orphaned contributions. This is the main argument for keeping Tiers 1 and 2 inside the indexer, and for restricting option 9.5.2 to finalised blocks with a lag.

## 9.7 Recommendation

| | Where | Cost |
|---|---|---|
| Lifetime totals, spend-by-category | `AccountBalance` (+ `lifetimeByKind` jsonField) | free |
| Account time series | `PolyxEntry.freeAfter`, or `AccountPolyxDaily` if measured to be needed | none / cheap |
| Ad-hoc slicing | `PolyxEntry` + pg-aggregates | none |
| Chain-wide series | bounded live aggregate, or external job over finalised blocks | none / external |

Net new entities remains **2** (`PolyxEntry`, `AccountBalance`), with `AccountPolyxDaily` as a measured-if-needed third. The summaries mostly ride along on a row that is already being written.

## 9.8 Open questions (continuing from §8.7)

16. **Does `lifetimeByKind` as a jsonField stay manageable** as `MovementKind` grows, or should the common few be promoted to columns?
17. **Is `AccountPolyxDaily` redundant** given `freeAfter`? Measure chart query latency both ways before building it.
18. **Backfill cost of lifetime totals** — they must be replayed from genesis to be correct. Does that fit the existing reindex window?
19. **Do counters need reconciliation too?** A drifted `totalFeesPaid` is invisible unless checked against `SUM(PolyxEntry)`. Suggest a periodic assertion in the same job as §3.4.
20. **Opening balance for the first day** of `AccountPolyxDaily` — derive from prior day's close, or from the entry preceding the window?
