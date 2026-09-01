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

### Reconciliation

Because `api.query` targets the block being indexed **[V]** (and `.at` is unsupported), verify against authoritative state for the current block only:

- every Nth block for accounts touched in that block
- always after `BalanceSet` and `DustLost`
- on mismatch: write an `IndexerAnomaly(BalanceReconciliationDrift)` **and correct** the derived value so drift cannot compound

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

---

## Consumer impact — breaking

| Consumer | Query | Change needed |
|---|---|---|
| SDK | `polyxTransactionsQuery` | **Rewrite.** `polyxTransactions` → `polyxEntries`. The `or: [{identityId,address},{toId,toAddress}]` filter collapses to `accountId: { equalTo: }` — a single indexed lookup. Keep `orderBy: [IdDesc]` (D4). |
| SDK | `PolyxTransactionsOrderBy` | Replaced by `PolyxEntriesOrderBy`. |
| Portal | — | No direct POLYX query. Unaffected. |

New capability worth telling both teams about: `accountBalance(id:, blockHeight:)` for point-in-time balance, and `groupedAggregates(groupBy: [KIND])` for spend-by-category — neither is expressible today.

**Sequencing note:** this is the largest single change in the review. It is also the one with the most evidence behind it (three independent confirmations of the `OR` pattern). Do [09](./09-infrastructure.md) first so decode failures are visible rather than silent during the rewrite.
