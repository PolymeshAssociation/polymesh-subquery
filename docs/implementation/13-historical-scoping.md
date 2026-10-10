# 13 — Historical scoping

Which entities actually need historical state tracking, and what it costs the ones that do not. Revisits [D3](../README.md) — *"historical state must stay enabled"* — which is currently a blanket decision taken without per-entity measurement.

**Depends on:** [09](./09-infrastructure.md). Overlaps [11](./11-throughput.md), which measures slow blocks; this measures the standing cost historical mode imposes on *every* block.

**Status:** for review. Nothing here is implemented.

---

## Measurement basis

All figures from a testnet genesis sync on 2026-09-10, captured at block **5.2M of 25.8M (~20%)**, `historical: 'height'`, 16 workers, against a non-rate-limited archive node.

Two caveats that bound every conclusion below:

1. **Partial sync.** Ratios are stable across the run so far but the v6/v8 eras are not yet represented. Re-measure before acting.
2. **The scan counts are the *indexer's* access pattern, not consumers'.** `pg_stat_user_indexes` here reflects what the handlers query during indexing. The SDK and portal (D2) may lean on historical lookups the indexer never makes. **This is the single biggest gap in this analysis** — §13.4 states what would close it.

---

## The constraint that shapes every option

**SubQuery's `--historical` is global, not per-entity.** There is no `@entity(historical: false)` directive and no per-model opt-out. Every `@entity` type gets `_block_range` and the GiST indexes that go with it.

So "scope historical to the entities that need it" is **not directly expressible**. The options are narrower than the framing suggests, and §13.3 sets them out honestly.

---

## 13.1 Two thirds of the database is append-only **[V]**

Classifying by whether a table has *ever* taken an `UPDATE`:

| Class | Tables | Total size | Inserts |
|---|---|---|---|
| **Append-only** (0 updates) | 24 | **1,067 MB** | 749,536 |
| Mutable | 31 | 325 MB | 332,547 |

**76% of a 1,406 MB database is data that is written once and never changes.** The largest append-only tables:

| Table | Size | Updates |
|---|---|---|
| `events` | 428 MB | 0 |
| `polyx_entries` | 371 MB | 0 |
| `staking_events` | 101 MB | 0 |
| `extrinsics` | 88 MB | 0 |
| `asset_transactions` | 21 MB | 0 |
| `blocks` | 20 MB | 0 |
| `instruction_events` | 14 MB | 0 |
| `instruction_parties` | 11 MB | 0 |

The genuinely mutable entities, by update rate:

| Table | Updates / inserts | Interpretation |
|---|---|---|
| `account_balances` | **79.3%** | running balance — mutates constantly |
| `asset_holders` | 67.9% | holder totals |
| `legs` | 51.2% | settlement leg status |
| `assets` | 41.7% | asset attributes |
| `instructions` | 36.9% | instruction status |
| `stat_types` | 21.3% | |
| `authorizations` | 17.7% | status transitions |
| `compliances` | 13.2% | |
| `accounts` | 9.8% | |
| `identity_keys` | 4.3% | see §13.2 |
| `claims`, `portfolios`, `identities`, `ticker_reservations`, `instruction_affirmations` | <3% | |

## 13.2 The cost is **not** row versioning — it is GiST index maintenance **[V]**

The intuition that historical mode "doubles writes" is **wrong for append-only entities**, and this is the most important correction in this document.

Historical mode closes a row (`UPDATE _block_range`) and inserts a new version *when an existing id is saved again*. An append-only entity never saves the same id twice — every `save()` is a fresh id, so there is nothing to close. Confirmed: all 24 append-only tables show `n_tup_upd = 0`. **No write amplification occurs there.**

What historical mode *does* cost them is the `(column, _block_range)` **GiST indexes**, maintained on every insert. GiST maintenance is materially more expensive than btree.

| Table | GiST indexes | GiST size | Heap size | GiST scans | btree scans |
|---|---|---|---|---|---|
| `polyx_entries` | 10 | **267 MB** | 83 MB | **99,675** | 231,667 |
| `events` | 8 | **168 MB** | 205 MB | **206** | 295,872 |
| `staking_events` | 6 | 62 MB | 32 MB | **49** | 98,637 |
| `extrinsics` | 10 | 27 MB | 23 MB | **209** | 25,484 |
| `asset_transactions` | 9 | 14 MB | 6 MB | **285** | 12,347 |
| `blocks` | 3 | 9 MB | 9 MB | **50** | 23,413 |

Two distinct findings, and they point opposite ways:

- **`polyx_entries` earns its GiST indexes** — 99,675 scans. The ledger handlers genuinely query by account across block ranges. Leave it alone.
- **`events`, `staking_events`, `extrinsics`, `asset_transactions`, `blocks` do not.** Roughly **280 MB of GiST indexes serving under 800 scans between them**, while their btree counterparts serve 450,000+. They are maintained on every insert and almost never read *by the indexer*.

`polyx_entries` also carries 267 MB of index on an 83 MB heap — a **3.2:1 index-to-heap ratio**. Even where the indexes are used, that ratio is worth a look.

## 13.3 Options

Given the global-flag constraint, these are the real choices.

**A. Do nothing.** D3 stands. Cost is ~280 MB of unused GiST indexes and their insert-time maintenance, growing linearly with the chain.

**B. Drop the unused GiST indexes post-schema-creation.** `db/compat.sql` already runs DDL after the node builds the schema ([`docker-entrypoint.sh`](../../docker/docker-entrypoint.sh)), so the mechanism exists. Drop `(col, _block_range)` GiST indexes on append-only entities where a btree serves the same lookups. Keeps historical semantics — `_block_range` is still written, so historical *queries* still work, just without index support on those paths.
  - **Risk:** a consumer historical query against `events` would go from index scan to sequential scan. Needs §13.4 first.

**C. Reduce declared indexes on append-only entities.** Several carry more `@index` directives than the indexer uses. Fewer declared indexes means fewer GiST indexes generated. Narrower than B and expressible directly in `schema.graphql`.

**D. Split the schema.** Move append-only entities to a second SubQuery project with historical off. Genuinely removes the cost; costs a second deployment, a second database schema, and cross-schema joins. **Not recommended** — the operational cost outweighs 280 MB.

Recommended sequence: **§13.4 → C → B**, measuring at each step.

## 13.4 What must be answered first

**Do consumers issue historical queries, and against which entities?**

This document measures the indexer's access pattern only. Before dropping any index:

1. Grep the SDK and portal connections (D2, `reference/consumer-queries.md`) for `blockHeight:` / historical query arguments.
2. Determine whether any consumer asks for `events`, `extrinsics`, `blocks` or `staking_events` *as of a past block*. For append-only entities the answer should be no by construction — a row that never changes reads the same at every height — but this needs confirming rather than assuming.
3. If no consumer queries append-only entities historically, option B is safe and its GiST indexes are dead weight for both indexer and consumer.

**Secondary question:** `IdentityKey` models its own validity window (`validFromBlock` / `validToBlock`, [04](./04-identity-keys.md)) *and* carries `_block_range`. `ticker_external_agent_histories` is likewise an explicit history table. That is two independent temporal models on the same rows. Whether the domain-level window makes the `_block_range` one redundant for these entities is worth deciding explicitly — it is currently accidental rather than chosen.

---

## Summary

- 76% of the database is append-only **[V]**
- Historical mode does **not** amplify writes there — no row-closing occurs **[V]**
- It does cost ~280 MB of GiST indexes that the indexer reads fewer than 800 times **[V]**
- `polyx_entries` is the exception: 99,675 GiST scans, genuinely load-bearing **[V]**
- Per-entity opt-out is not available in SubQuery; index-level pruning is the actionable lever
- **Consumer query patterns must be established before dropping anything**
