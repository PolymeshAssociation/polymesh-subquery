# 07 — Staking

Turns a raw event stream into queryable position state.

**Entities:** `StakingPosition` (new), `Era` (new), `Validator` (new), `StakingEvent` (kept, extended).

**Depends on:** [02](./02-polyx-ledger.md) — the v7/v8 lock-vs-hold split is decided there.

---

## Problem

`staking` is **8/32 handled**. `StakingEvent` is a log, not a position, so *"how much is this account staking right now, and with whom"* requires replaying every event. There is no `StakingPosition`, `Nomination`, `Validator`, or `Era` entity.

The portal queries `stakingEvents` and filters `eventId: { in: [Reward, Rewarded] }` **[V]** — i.e. it is reconstructing reward history from a raw stream, which is the symptom.

Unhandled and consequential: `PayoutStarted`, `EraPaid`, `Chilled`, `Kicked`, `ValidatorPrefsSet`, `StakersElected`, `SlashReported`, `CommissionCapUpdated`, `PermissionedIdentityAdded`/`Removed`.

---

## Target schema

```graphql
type StakingPosition @entity {
  id: ID!                        # stash address
  stash: Account! @index
  controller: Account
  identity: Identity @index

  "currently bonded (active in the staking ledger)"
  bonded: BigInt!
  "in the unbonding queue, not yet withdrawable"
  unbonding: BigInt!
  "unbonding chunks with their unlock eras"
  unlocking: [UnlockChunk]

  rewardDestination: String
  rewardDestinationAccount: Account

  totalRewarded: BigInt!         # lifetime — free, row already written
  totalSlashed: BigInt!
  updatedBlock: Block!
}

type UnlockChunk @jsonField { amount: BigInt!, era: Int! }

type Validator @entity {
  id: ID!                        # stash address
  account: Account! @index
  identity: Identity @index
  commission: BigInt
  blocked: Boolean!
  isPermissioned: Boolean!
  isActive: Boolean!
  updatedBlock: Block!
}

type Era @entity {
  id: ID!                        # padId(eraIndex)
  eraIndex: Int! @index(unique: true)
  startBlock: Block!
  endBlock: Block
  validatorPayout: BigInt
  remainder: BigInt
  totalStaked: BigInt
}
```

### `StakingEvent` — keep

The portal queries it directly **[V]**. Keep as the append-only log; add `eraIndex` so reward history is groupable without a join:

```diff
  type StakingEvent @entity {
+   eraIndex: Int @index
+   position: StakingPosition
  }
```

---

## The v7 → v8 inversion

This is the correctness core, and it is verified **[V]**:

| Era | Mechanism | Balance effect |
|---|---|---|
| ≤ v7.4 | `T::Currency::set_lock(STAKING_ID, …)` (`pallets/staking/src/pallet/impls.rs:313`) | **None.** `free` unchanged; `misc_frozen` rises. |
| v8 | `RuntimeHoldReason::Staking` hold | `free -= v; reserved += v`, emitting `balances.Held` |

So `staking.Bonded`/`Unbonded`/`Withdrawn` update **`StakingPosition` only** in both eras. The balance effect is:
- ≤ v7.4 → a lock entry on `AccountBalance.locks`
- v8 → the paired `balances.Held`/`Released`, handled in [02](./02-polyx-ledger.md)

Recording a POLYX movement from the `staking.*` events themselves would be wrong pre-v8 (nothing moved) and double-counted on v8.

`Withdrawn` **[V]** — "essentially frees up that balance" — decrements `unbonding`; the balance side is `Unbonded → Free` in the ledger, not another credit (A6).

### Era resolution

`Rewarded { stash, dest, amount }` carries no era, but `PayoutStarted { eraIndex, validatorStash, page, next }` precedes it in the same payout **[V]**. Handle `PayoutStarted`, hold the era for the extrinsic, and stamp it on the `Rewarded` entries and `StakingEvent` rows.

**[I]** Verify the pairing holds for multi-page payouts (`page`, `next`) before relying on it.

## Not tracked: nominations, chilled, validating

Who a stash nominates, and whether it is chilled or validating right now, are not indexed. The
chain doesn't announce every change: from 8.0 `nominate` emits no event, before 7.0 `chill` emits
none, and a full withdrawal or a `validate` drops a nominator silently. Rows built from events
would drift, and nothing reads them. The current state is one read (`staking.nominators`,
`staking.validators`); who backed whom in an era is the era's exposure. `Nominated` events stay in
`StakingEvent` as a log, which ends at 8.0.

---

## Handler changes

**File:** `src/mappings/entities/events/mapStakingEvent.ts`

| Handler | Change |
|---|---|
| `handleStakingEvent` | Keep writing `StakingEvent`; additionally maintain `StakingPosition`. |
| `get8xStakingEventDetails` | Replace the silent `return { stashAccount }` fallthrough (defect B3) with an explicit exhaustive switch that writes an `IndexerAnomaly` on an unhandled id. |
| `extract8xStakingAmount` | Retire. The numeric-regex shape sniff (B1) is replaced by named-field decode ([09](./09-infrastructure.md)) — v8 staking events are all named structs **[V]**. |
| **new** `handlePayoutStarted` | Record era; create/update `Era`. |
| **new** `handleEraPaid` | Close `Era`, set `validatorPayout`/`remainder`. |
| **new** `handleValidatorPrefsSet` | Upsert `Validator.commission`/`blocked`. |
| **new** `handleStakersElected` | Mark active validators for the era. |

---

## project.ts

```diff
  staking: {
-   EraPaid: [], PayoutStarted: [],
-   PermissionedIdentityAdded: [], PermissionedIdentityRemoved: [],
-   SlashReported: [], StakersElected: [], ValidatorPrefsSet: [],
+   EraPaid: ['handleEraPaid'],
+   PayoutStarted: ['handlePayoutStarted'],
+   PermissionedIdentityAdded: ['handlePermissionedIdentityAdded'],
+   PermissionedIdentityRemoved: ['handlePermissionedIdentityRemoved'],
+   SlashReported: ['handleSlashReported'],
+   StakersElected: ['handleStakersElected'],
+   ValidatorPrefsSet: ['handleValidatorPrefsSet'],
  }
```

Election-provider and snapshot-size events stay `[]` — chain mechanics with no domain entity. Comment them so the "registered, not handled" report does not re-flag them.

---

## Tests

- **Unit:** v7 `Bonded` increments `StakingPosition.bonded` and produces **no** `PolyxEntry`; v8 `Bonded` + paired `Held` produces one `Free → Reserved` entry and the same position change. The regression test for the inversion.
- **Unit:** `Unbonded` moves `bonded → unbonding` with an `UnlockChunk`; `Withdrawn` decrements `unbonding`.
- **Unit:** `PayoutStarted` then `Rewarded` stamps the correct `eraIndex`.
- **Unit:** an unhandled 8.x staking event writes an `IndexerAnomaly` instead of silently dropping `amount`.
- **Integration:** for a sample of stashes, `StakingPosition.bonded` matches `api.query.staking.ledger` at the same block.
- **Integration:** `SUM(StakingEvent.amount WHERE eventId in [Reward, Rewarded])` per stash equals `StakingPosition.totalRewarded`.

---

## Consumer impact

| Consumer | Query | Impact |
|---|---|---|
| Portal | `stakingEvents` | **Compatible.** `StakingEvent` is retained with the same shape; `eraIndex` and `position` are additive. Its `eventId: { in: [Reward, Rewarded] }` filter keeps working. |
| SDK | — | No staking queries **[V]**. |

Additive for consumers. The value is the new capability: current bonded/unbonding per account, and per-era reward aggregation via `groupedAggregates(groupBy: [ERA_INDEX])` — none expressible today.
