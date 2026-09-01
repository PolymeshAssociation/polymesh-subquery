# 02 — POLYX ledger

Replaces `PolyxTransaction` with an entry-centric ledger plus a materialised balance. Full design rationale in [`../reference/polyx-balance-model.md`](../reference/polyx-balance-model.md).

**Entities:** `PolyxEntry` (new), `AccountBalance` (new), `PolyxTransaction` (removed), `BalanceTypeEnum` (replaced).

**Depends on:** [09](./09-infrastructure.md) — decode layer and `IndexerAnomaly`.

---

## Problem

Four structural faults, each independently fatal to "balance at any block":

1. **One `type` column for a two-sided movement.** `Reserved` is `Free → Reserved`; a single column records half.
2. **`frozen` is a MAX, not a SUM.** Locks aggregate by maximum, so no amount of summing movement rows produces it.
3. **`BalanceSet` is absolute, recorded as a delta**, corrupting every running total after it.
4. **`BalanceTypeEnum` conflates three systems** — real pools (`Free`, `Reserved`), a lock-floor (`Locked`), and staking-ledger states (`Bonded`, `Unbonded`) whose mechanism *inverted* at v8 **[V]**.

Plus A9: eight v8 events unregistered, so `reserved` is entirely unindexed on v8.

---

## Target schema

```graphql
"""
One row per (account, movement side). Append-only.
Sibling entries of one on-chain movement share `movementId`.
"""
type PolyxEntry @entity @compositeIndexes(fields: [["accountId", "date"], ["accountId", "kind"], ["kind", "date"]]) {
  id: ID!                        # padId(block)/padId(eventIdx)/side  — D4
  movementId: String! @index

  account: Account!
  identity: Identity @index
  counterpartyAddress: String @index
  counterpartyIdentity: Identity

  pool: PolyxPool!
  "signed: negative = debit, positive = credit. SUM = net delta"
  amount: BigInt!
  "unsigned. SUM = gross volume"
  amountAbs: BigInt!

  kind: MovementKind!
  "materialised — sign(amount) is not groupable (§8b)"
  direction: EntryDirection!
  holdReason: HoldReason
  memo: String

  "balance after this entry — powers charts with no aggregation"
  freeAfter: BigInt!
  reservedAfter: BigInt!
  frozenAfter: BigInt!

  "denormalised — aggregation cannot traverse relations"
  moduleId: ModuleIdEnum
  callId: CallIdEnum
  eventId: EventIdEnum!
  specVersionId: Int!
  "materialised time buckets — no date_trunc grouping exists (§8b)"
  date: Date! @index
  eraIndex: Int @index

  event: Event!
  extrinsic: Extrinsic
  eventIdx: Int!
  datetime: Date!
  createdBlock: Block!
}

enum PolyxPool { Free, Reserved }
enum EntryDirection { Debit, Credit }
enum HoldReason { Staking, Session, Preimage, Revive, Unknown }
enum MovementKind {
  Transfer, Endowment, Fee, Tip, TreasuryDisbursement, TreasuryReimbursement,
  StakingReward, Slash, Mint, Burn, DustLost, ReserveRepatriation,
  Hold, Release, BalanceSetAdjustment
}

type AccountBalance @entity {
  id: ID!                        # address
  account: Account!
  identity: Identity @index

  free: BigInt!
  reserved: BigInt!
  "MAX over active locks — maintained from `locks`, never summed"
  frozen: BigInt!
  total: BigInt!
  "free - frozen, floored at 0"
  transferable: BigInt!
  bonded: BigInt!
  otherReserved: BigInt!

  "lifetime totals — free, this row is already versioned on these blocks"
  totalReceived: BigInt!
  totalSent: BigInt!
  totalFeesPaid: BigInt!
  totalRewards: BigInt!
  totalSlashed: BigInt!
  movementCount: Int!
  lifetimeByKind: [KindTotal]

  "per-lock detail — required because frozen is a MAX"
  locks: [LockEntry]
  "v8 only; SUM = reserved"
  holds: [HoldEntry]

  updatedBlock: Block!
}

type KindTotal @jsonField { kind: MovementKind!, totalAbs: BigInt!, net: BigInt!, count: Int! }
type LockEntry @jsonField { lockId: String!, amount: BigInt!, reasons: String }
type HoldEntry @jsonField { reason: HoldReason!, amount: BigInt! }
```

`PolyxPool` has exactly **two** members. `Bonded`/`Unbonded`/`Locked` are not pools.

**Time travel** comes free: `historical: 'height'` is the default and is explicitly passed in `docker-entrypoint.sh` (`--disable-historical=false`) **[V]**, so `accountBalance(id: X, blockHeight: N)` works. `freeAfter` on entries is an independent second mechanism; disagreement between them is a defect signal.

---

## Handler changes

**File:** `src/mappings/entities/identities/mapPolyxTransaction.ts` → rewrite as `mapPolyxLedger.ts`.

Every handler becomes: decode → resolve pool transition → write entries → update `AccountBalance`.

### Event → pool transition

Verified emissions **[V]** (`pallets/balances/src/lib.rs` @ v7.4.0, `types-lookup.ts` @ 8.0.1):

| Event | from | to | Kind |
|---|---|---|---|
| `Transfer` | `from/Free` | `to/Free` | Transfer |
| `Endowed` | ∅ | `who/Free` | Endowment |
| `Reserved(who,v)` — `free -= v; reserved += v` | `who/Free` | `who/Reserved` | Hold |
| `Unreserved(who,v)` — `reserved -= v; free += v` | `who/Reserved` | `who/Free` | Release |
| `ReserveRepatriated` | `from/Reserved` | `to/Free`\|`Reserved` per status | ReserveRepatriation |
| `Held{reason,who,amount}` **(v8, new)** | `who/Free` | `who/Reserved` | Hold |
| `Released{reason,who,amount}` **(v8, new)** | `who/Reserved` | `who/Free` | Release |
| `BurnedHeld` **(v8, new)** | `who/Reserved` | ∅ | Slash |
| `TransferOnHold` **(v8, new)** | `source/Reserved` | `dest/Reserved` | ReserveRepatriation |
| `TransferAndHold` **(v8, new)** | `source/Free` | `dest/Reserved` | ReserveRepatriation |
| `Burned`/`Slashed`/`Withdraw`/`Suspended` | `who/Free` | ∅ | Burn/Slash |
| `Minted`/`Deposit`/`Restored` | ∅ | `who/Free` | Mint |
| `DustLost` **(new)** | `account/Free` | ∅ | DustLost |
| `AccountBalanceBurned` (≤v7) | `who/Free` | ∅ | Burn |
| `FeeCharged`, `TransactionFeePaid` | `who/Free` | ∅ | Fee |
| `TreasuryDisbursement` | treasury`/Free` | `to/Free` | TreasuryDisbursement |
| `staking.Rewarded`/`Reward` | ∅ | `stash/Free` | StakingReward |
| `staking.Slashed`/`Slash` | `staker/Free` | ∅ | Slash |

### Not movements

- **`BalanceSet`** — a **checkpoint**. Set `AccountBalance.free`/`reserved` absolutely; write one `BalanceSetAdjustment` entry recording the delta so the ledger still reconciles. Resolves A1 structurally.
- **`Locked`/`Unlocked`/`Frozen`/`Thawed`** — update `AccountBalance.locks` only; recompute `frozen = MAX(active locks)`. No entry.
- **`Issued`/`Rescinded`/`TotalIssuanceForced`/`MintedCredit`/`BurnedDebt`** — total-issuance only, no account side. **[I]** Consider a `TotalIssuance` entity; out of scope here.
- **`Upgraded`** — account flag migration, no amount.
- **`TransferWithMemo`** — memo enrichment of the paired `Transfer`, never its own entry (resolves A2 option (b)).

### Staking — era-dependent, and inverted at v8 **[V]**

- **≤ v7.4**: bonding is `set_lock(STAKING_ID, …)` — **no balance moves**. `Bonded`/`Unbonded`/`Withdrawn` update `locks` only. This is the correction to A6: the current `type: Bonded` rows assert movements that never happened.
- **v8**: bonding is a Hold. The balance effect arrives via `balances.Held{reason:Staking}` / `Released`; the `staking.*` events become ledger state only. Recording both would double count.

**[I]** Confirm the `staking.Bonded` ↔ `balances.Held{reason:Staking}` pairing within one extrinsic against a real v8 block before relying on it.

### Genesis

`genesisHandler` seeds **no balances at all** **[V]**. Add a genesis `AccountBalance` snapshot from `api.query.system.account` entries, or every derived balance is wrong by the genesis allocation. **Hard prerequisite.**

Write it as a **domain seeder in `src/seed/`** rather than inline in `genesisHandler`. Plan [10](./10-partial-index.md) needs the identical read — "snapshot `system.account` at block B and create `AccountBalance` rows" — with the only difference being which block. Writing it once, called from both entry points, is the difference between one seeder and two that drift.

### Reconciliation — in-flight

Because `api.query` targets the block being indexed **[V]** (and `.at` is unsupported), verify against authoritative state for the current block only:

- every Nth block for accounts touched in that block
- always after `BalanceSet` and `DustLost`
- on mismatch: write an `IndexerAnomaly(BalanceReconciliationDrift)` **and correct** the derived value so drift cannot compound

---

## Accounting fidelity — the part events cannot supply (D11)

**These rows are used for accounting.** That is a different bar from the rest of the review: elsewhere a coverage gap leaves a capability absent, and here it leaves a number that looks complete and is not. The design above derives every balance from events; this section is about where the events are *insufficient*, which no amount of derivation fixes.

### Known gap: pre-v8 staking reward destination **[V]**

[`mapStakingEvent.ts:110-130`](../../src/mappings/entities/events/mapStakingEvent.ts#L110) records `rewardDestination: 'LegacyUnknown'` for every pre-8.x `Reward`/`Rewarded`, because the event carries only the **stash** and the amount. Where a staker set a payee other than their stash — `Controller`, or an explicit `Account` — the index cannot say which account received the POLYX. Defect A15.

The v8 path is correct: `get8xStakingEventDetails` decodes the `RewardDestination` variant and resolves `rewardDestinationAccount` for `Account`, `Staked` and `Stash` **[V]**.

`LegacyUnknown` is an honest placeholder, not a wrong value — but it means a pre-v8 reward cannot be reconciled against the receiving account's balance, and it is invisible to anyone who does not know what the string means.

**Recoverable, two ways.** They are not equivalent, and the choice is really a scope decision (below).

**(a) Read `staking.payee(stash)` at the reward block.** Chain storage, authoritative, one read per reward event during the genesis replay — no archive of anything but state required. Under D5 the replay is happening anyway, which makes this close to free *if it is done then* and awkward afterwards.

**(b) Derive a payee timeline from extrinsics.** The chain **never emits a payee event** — verified against v8 metadata, which carries 19 staking events and none of them payee-related **[V]**. So there is nothing to subscribe to; the only trace is the call:

| Call | Effect |
|---|---|
| `staking.bond(value, payee)` | sets the **initial** destination — `Staked` / `Stash` / `Controller` / `Account` / `None` **[V]** |
| `staking.setPayee(payee)` | changes it; signed by the **controller**, not the stash **[V]** |
| `staking.updatePayee(controller)` | v8 migration helper that rewrites `Controller` → `Account(controller)` **[V]** |

`set_payee` and `update_payee` are already in `CallIdEnum` **[V]**, so the calls are visible; nothing consumes them.

Attractive because it costs **zero chain reads**. But a timeline built from calls has four gaps, and each is a place to be silently wrong rather than loudly missing:

1. **Nested calls.** A `set_payee` inside `utility.batch` produces an `Extrinsic` row for the *batch*. Inner calls must be unwrapped or the change is invisible.
2. **Controller vs stash.** `setPayee` is signed by the controller; rewards are keyed by the stash. Resolving one to the other needs a *second* derived timeline, from `bond` and `setController`.
3. **Genesis stakers** have no `bond` extrinsic at all, so their initial destination is unknowable from calls.
4. **`updatePayee`** is exactly the silent-migration shape as A11 and the authorization-payload repair: state changes under a rewrite that the call arguments alone do not describe.

**Recommendation: (a) for correctness of the ledger, (b) only if staking history becomes a domain in its own right.** The storage read answers the accounting question directly with no reconstruction; the extrinsic timeline is most of a `StakingPosition` model, and is worth building only if that model is wanted — see the scope question below.

**Decide on measurement, not principle.** Unmeasured: the share of pre-v8 rewards whose payee differed from the stash. Sample `staking.payee` across a spread of eras on mainnet and testnet before committing to either — if it is near zero, `LegacyUnknown` documented in the schema is a defensible answer and neither option is worth building.

### Scope question: is staking history this indexer's job? **[decision needed]**

The indexer has no first-class staking state at all — `StakingEvent` is a log, and `StakingPosition` / `Nomination` / `Validator` / `Era` do not exist (`../entity-review.md` §13). Every option above is a step toward building that, and it is reasonable to ask whether it should be.

**For:** POLYX is the chain's native asset, staking is where most of it moves, and the reward rows are already being read for accounting — a ledger that cannot attribute a reward is incomplete *as a ledger*, independent of any staking feature.

**Against:** validator sets, nominations, era exposure and payout scheduling are a different domain with a different audience, and the SDK now answers most of the live-state questions directly from the chain. Indexing them fully is a large surface — `staking` is **8/32 handled** — and it competes with the securities-domain gaps (corporate actions, checkpoints, ballots) that are arguably more central to what this index is *for*.

**A middle line, and the one this plan assumes:** index enough staking to make the **POLYX ledger** correct and attributable — reward destination, `PayoutStarted` for `eraIndex`, the bonded/unbonded transitions — and treat validator/nomination/era modelling as a separate, later decision. Plan [07](./07-staking.md) is written on that basis and should be re-read with this question in mind rather than assumed.

### Suspected gap: fee attribution across runtime versions **[I]**

Splitting a transaction fee between validator, treasury and payer was derived rather than emitted on older runtimes, so `protocolfee.FeeCharged` and `transactionpayment.TransactionFeePaid` may not account for the whole fee at every spec version.

**This has not been verified.** It is the same *class* as the reward gap — an accounting fact the event does not carry — and it is listed here so the reconciliation below is designed to catch it rather than assume it away. The entity-by-entity version sweep (defect-log §E) is where it gets settled against chain source.

### The reconciliation harness — an acceptance test, not a follow-up

The in-flight reconciliation above catches drift *going forward*. It cannot answer "is the history right", because it only ever compares at the block being indexed. A separate offline harness does that, and it is a deliverable of this plan.

**Method:**

1. **Pick a sample, not the population.** Accounts stratified by activity — a few dozen high-traffic, a few dozen typical, plus every account that appears in a `BalanceSet`, `DustLost`, `Slashed` or pre-v8 `Reward` row. The last group is where the suspected gaps live, so it is oversampled deliberately.
2. **Pick blocks at the version boundaries.** One block before and one after each of `5_000_000`, `6_000_000`, `7_000_000`, `7_003_000`, `7_004_001`, `8_000_000`. A drift that only appears on one side of a boundary names the runtime that caused it.
3. **Compare** `SUM(entries) up to block N` against `system.account(address)` read at block N, for `free`, `reserved` and `frozen` independently. Comparing only the total hides a pair of offsetting errors, which is exactly what a `fromPool`/`toPool` mistake produces.
4. **Classify every mismatch** rather than reporting a count. A drift constant from a given block is one missed event; a drift that grows is a systematically mis-signed one; a drift that appears only in `reserved` is a pool mapping error. The taxonomy is the output — a total is not actionable.

**Available access:** public endpoints — `wss://mainnet-rpc.polymesh.network`, `wss://testnet-rpc.polymesh.live`, the dictionaries, and the hosted middleware GraphQL. That is enough for a sampled comparison at chosen blocks; it is not enough for a full-history sweep of every account, and it is rate-limited. Design the harness to resume, and to run against a local archive node unchanged if one becomes available.

**Acceptance:** the plan is not done when the resync completes. It is done when the harness reports zero unexplained mismatches across the sample, with every explained one written up. Per the shared "definition of done", *"reconciliation counts for the domain are zero (or explained)"* — this section is what "or explained" means for POLYX.

---

## project.ts

Register the eight missing v8 events (A9) and give the two empty ones handlers:

```diff
  balances: {
+   Held: ['handleBalanceHeld'],
+   Released: ['handleBalanceReleased'],
+   BurnedHeld: ['handleBalanceBurnedHeld'],
+   TransferOnHold: ['handleTransferOnHold'],
+   TransferAndHold: ['handleTransferAndHold'],
+   MintedCredit: [],          # issuance only — no account side
+   BurnedDebt: [],            # issuance only
+   Unexpected: [],            # anomaly marker; consider IndexerAnomaly
-   DustLost: [],
+   DustLost: ['handleDustLost'],
-   Thawed: [],
+   Thawed: ['handleBalanceThawed'],
-   Suspended: ['handleBalanceSuspended'],   # A3 — function did not exist
+   Suspended: ['handleBalanceSuspended'],   # now implemented
  }
```

---

## Tests

- **Unit, per row of the transition table:** fixture → expected `(fromPool, toPool, kind, amount)`.
- **Unit:** `Reserved` then `Unreserved` returns `free`/`reserved` to their starting values — the property the current model cannot satisfy.
- **Unit:** v7 `Bonded` produces **no** entry and raises `frozen`; v8 `Held{Staking}` produces `Free → Reserved`.
- **Unit:** `BalanceSet` sets absolutely and does not corrupt subsequent totals.
- **Unit:** two overlapping locks of 100 and 150 give `frozen = 150`, not 250.
- **Integration:** after resync, `SUM(amount) WHERE toPool=X` minus `SUM WHERE fromPool=X` equals `AccountBalance` for a sample of accounts.
- **Integration:** `AccountBalance` at `blockHeight: N` agrees with the latest `PolyxEntry.freeAfter` at or before N.
- **Reconciliation harness** (D11) — the acceptance gate, run against public archive endpoints across the version-boundary blocks. `free`, `reserved` and `frozen` compared **independently**, so a pair of offsetting pool errors cannot cancel out and pass. Output is a mismatch taxonomy, not a count.
- **Unit:** a pre-v8 `Reward` whose payee is an explicit `Account` resolves to that account, not the stash — the fixture that pins A15 once the `staking.payee` read lands. Until then, a test asserting `LegacyUnknown` so the placeholder cannot be mistaken for a resolved value.

---

## Consumer impact — breaking

| Consumer | Query | Change needed |
|---|---|---|
| SDK | `polyxTransactionsQuery` | **Rewrite.** `polyxTransactions` → `polyxEntries`. The `or: [{identityId,address},{toId,toAddress}]` filter collapses to `accountId: { equalTo: }` — a single indexed lookup. Keep `orderBy: [IdDesc]` (D4). |
| SDK | `PolyxTransactionsOrderBy` | Replaced by `PolyxEntriesOrderBy`. |
| Portal | — | No direct POLYX query. Unaffected. |

New capability worth telling both teams about: `accountBalance(id:, blockHeight:)` for point-in-time balance, and `groupedAggregates(groupBy: [KIND])` for spend-by-category — neither is expressible today.

**Sequencing note:** this is the largest single change in the review. It is also the one with the most evidence behind it (three independent confirmations of the `OR` pattern). Do [09](./09-infrastructure.md) first so decode failures are visible rather than silent during the rewrite.
