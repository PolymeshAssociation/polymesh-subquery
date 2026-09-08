# POLYX ledger — reconciliation and the accounting-fidelity findings

Companion to [`../implementation/02-polyx-ledger.md`](../implementation/02-polyx-ledger.md).
Records what was verified against chain state while building the ledger, and how to run the
acceptance gate (D11).

---

## Verified against real v8 blocks — the `staking.Bonded` ↔ `balances.Held{Staking}` pairing

Plan 02 §"Staking" made the v8 handling conditional on confirming that bonding's balance movement
arrives as `balances.Held{reason:Staking}` in the same extrinsic as `staking.Bonded`. Checked on
Polymesh **testnet** (spec 8001000):

| Block | Call | Events in the extrinsic |
|---|---|---|
| 25163012 | `staking.bondExtra` | `Withdraw`(fee), **`Held{Staking, 9640951}`**, **`Bonded{9640951}`**, `Deposit`(fee refund), `TransactionFeePaid` |
| 25107475 | `staking.withdrawUnbonded` | `Withdraw`(fee), **`Released{Staking, 5000000000}`**, **`Withdrawn{5000000000}`**, `Deposit`, `TransactionFeePaid` |
| 25721280 | `staking.rebond` | `Withdraw`(fee), `Bonded{5874231757}` — **no `Held`** |
| 25774711 | payout (`Initialization`) | per nominator: `Deposit{amount}`, `Held{Staking, amount}` (for `dest:Staked`), `Rewarded{stash, dest, amount}` |

**Conclusion — the pairing holds.** The balance movement is always the `Held`/`Released` event
where there is one; `staking.Bonded`/`Unbonded`/`Withdrawn` are ledger-state events. `rebond`
correctly emits `Bonded` with no `Held` because no balance moves (funds move between the ledger's
`unlocking` and `active` within an existing hold). So on v8 the ledger writes **no `PolyxEntry`**
for the `staking.*` events — the entry comes from the paired `balances` event — and this is
correct, not an under-count.

Pre-v8 (≤ v7.4) bonding is `set_lock(STAKING_ID, …)` and moves no balance: `Bonded`/`Withdrawn`
maintain `AccountBalance.locks` only, `frozen = MAX(active locks)`, still no `PolyxEntry`.

---

## Measured — defect A15, the pre-v8 reward-destination gap

Pre-8.x `staking.Reward`/`Rewarded` carries only the stash. `scripts/measure-a15-payees.ts`
sampled `staking.payee(stash)` at the reward block for pre-v8 reward stashes across a spread of
eras on both networks:

- **Near the v8 boundary** (last pre-v8 payout era): ~190 distinct stashes, **100% `Staked`/`Stash`**.
- **Across earlier eras** (mainnet spec 3010 → 7004001): a **large share** paid to `Controller`
  or an explicit `Account` — e.g. every sampled stash at spec 3010 used `Controller`; `Account`
  payees common at spec 5003001 / 6001031 / 7003003 / 7004001.

**Decision: not near-zero — the storage read was added.** `resolveLegacyRewardDestination`
(`src/utils/staking.ts`) reads `staking.payee(stash)` (and `staking.bonded(stash)` for the
`Controller` case) at the reward block, resolving the real recipient. It is wired into both
`mapStakingEvent` (`StakingEvent.rewardDestination` / `rewardDestinationAccount`) and the ledger
(`handleReward` credits the resolved account). `LegacyUnknown` remains only as the fallback when
the read is not possible (a pruned node), and `rewardDestinationA15.test.ts` pins that it is
never silently resolved to the stash instead.

Cheap now — the read happens during the D5 genesis replay, which is running anyway. Awkward
later — it would need an archive node holding the pre-v8 state. That asymmetry is why it is done
in this phase rather than deferred.

---

## The reconciliation harness (D11) — the acceptance gate

### In-flight — `src/mappings/entities/identities/reconcilePolyx.ts`

Wired into the ledger handlers. Every 500th block for accounts touched in that block, and always
after `BalanceSet` / `DustLost`, the derived `AccountBalance` is compared against `system.account`
read at the block being indexed (`api.query` targets the current block; `.at` is unsupported).
On a mismatch it writes a `BalanceReconciliationDrift` anomaly **and corrects** the derived
value, so drift from one missed or mis-signed event cannot compound into every later balance.

### Offline — `scripts/reconcile-polyx.ts`

Run separately from block indexing, against a **synced local database** and a public archive RPC:

```
DB_HOST=… DB_PORT=… DB_USER=… DB_PASS=… DB_DATABASE=… \
  yarn ts-node scripts/reconcile-polyx.ts --rpc wss://mainnet-rpc.polymesh.network
```

- Samples accounts stratified by activity, oversampling everyone in a `BalanceSetAdjustment`,
  `DustLost`, `Slash` or pre-v8 `StakingReward` entry.
- Compares at one block before and one after each of 5_000_000, 6_000_000, 7_000_000,
  7_003_000, 7_004_001, 8_000_000.
- Compares `free`, `reserved`, `frozen` **independently**, and cross-checks `SUM(PolyxEntry)`
  against `AccountBalance` (the two time-travel mechanisms in §7.4 of plan 02 must agree).
- Output is a **mismatch taxonomy**: constant drift from a block = one missed event; growing
  drift = a systematically mis-signed one; drift confined to `reserved` = a pool-mapping error.
- Resumable via `.reconcile-polyx.checkpoint.json`.

**Acceptance for the phase:** the harness reports zero unexplained mismatches across the sample,
with every explained one written up here or in the PR body. This — not "the resync completed" —
is the gate.
