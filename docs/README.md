# Polymesh SubQuery — Indexer Review

Audit and redesign proposals for the Polymesh indexer.

Reviewed on branch **`alpha`**, cross-referenced against `PolymeshAssociation/Polymesh` tags `v4.1.x`–`v8.0.2`, the deployed `onfinality/subql-query:v2.25.0` image, `polymesh-types@feat/8.0.1-types`, `polymesh-sdk`, and `polymesh-portal`.

Claims are tagged **[V]** (verified against source) or **[I]** (inference needing confirmation).

---

## How to read this

| Document | What it covers | Read it when |
|---|---|---|
| **[architecture-review.md](./architecture-review.md)** | How the indexer is *built* — version handling, decoding, enum codegen, indexes, aggregation, rollups, testing, sequencing | Planning the work |
| **[entity-review.md](./entity-review.md)** | The *data model* — all 67 entities by domain, each judged against the use case it serves | Deciding what to change |
| **[implementation/](./implementation/README.md)** | Ten per-domain plans: schema diffs, handler changes, `project.ts`, tests, consumer impact | Doing the work |
| [reference/defect-log.md](./reference/defect-log.md) | Confirmed defects (A1–A12) and fragile patterns (B1–B8) | Fixing something specific |
| [reference/event-shape-verification.md](./reference/event-shape-verification.md) | Event-by-event shape comparison v4.1.3 → v8.0.2 for every planned domain | Writing a decoder |
| [reference/consumer-queries.md](./reference/consumer-queries.md) | What the SDK and portal actually query, and what that evidence settles | Judging blast radius |
| [reference/polyx-balance-model.md](./reference/polyx-balance-model.md) | Ground-up POLYX balance design | Working on balances |
| [reference/identity-asset-model.md](./reference/identity-asset-model.md) | Ground-up identity/key and asset-lifecycle design | Working on identities or assets |

Start with the two primary documents. The reference set is evidence and detailed design.

---

## Decision log

| # | Decision | Date | Consequence |
|---|---|---|---|
| D1 | **Breaking changes are accepted.** Redesign may replace entities outright. | 2026-08-31 | Additive → deprecate → remove staging in the reference designs is superseded. Backfill constraint remains. |
| D2 | **Consumer surface is `polymesh-sdk` (27 connections, `origin/develop`) + `polymesh-portal` (5, `origin/main`).** `polymesh-rest-api` has no direct GraphQL. | 2026-08-31 | Blast radius is bounded and enumerable — see `reference/consumer-queries.md` §1. |
| D4 | **The padded composite-id scheme is preserved, not retired.** | 2026-08-31 | It is load-bearing for deterministic pagination in both consumers **[V]**. Every new paginated entity needs a padded block-then-index id. Reverses an earlier `@dbType` proposal — see `architecture-review.md` §8b. |
| D5 | **Full resync from genesis. All existing `db/migrations/*` are deleted.** | 2026-08-31 | Migrations exist only to change schema *without* a resync; that constraint is gone. The redesign ships as a clean `schema.graphql` with no `ALTER TYPE` backfill files. **This also resolves the reindex-budget question** — a genesis replay is the plan, not a risk to be sized. Migration tooling becomes relevant again only for incremental changes *after* the reset. |
| D3 | **Historical state must stay enabled.** | 2026-08-31 | `historical: 'height'` is the default **[V]** and the balance design depends on it. `--disable-historical` is off the table; the sync-speed option is forfeited deliberately. |
| D6 | **Corporate actions, checkpoints and ballots are in scope — at low priority.** | 2026-08-31 | Plan [06](./implementation/06-corporate-actions.md) stays, sequenced after the correctness and model work. It is purely additive and needs no version branching beyond one legacy decoder, so it can land independently whenever capacity allows. |
| D7 | **Fiat valuation is out of scope for v1.** No `valueUsd` column, no `PolyxPrice` entity. | 2026-08-31 | Keeps every number in the index reproducible from chain state alone — no external oracle. USD sums would have required the value *on the row* (pg-aggregates cannot traverse relations), so this forgoes that capability deliberately. Reversible later as a mechanical one-column backfill. |

---

## Questions resolved during review

Each of these was open; all are now settled with evidence.

| Question | Answer | Evidence |
|---|---|---|
| Were pre-v8 child identities unlinked at the upgrade? | **Yes — silently.** `ParentDid::drain()` + `ChildDid::remove()`, no events emitted. Index holds stale rows forever. | `v8.0.0:pallets/identity/src/migrations.rs` **[V]** — now defect A11 |
| Does `CreatedAssetTransfer.pendingTransferId` need its own state machine? | **No.** It is an `InstructionId` — a deferred transfer *becomes a settlement Instruction*, already modelled. Make it a relation to `Instruction`. | `v8.0.0:pallets/asset/src/lib.rs:2876-2883` **[V]** |
| Is `eraIndex` resolvable at index time for staking entries? | **Yes**, from `PayoutStarted { eraIndex, validatorStash, page, next }`, which precedes `Rewarded` in the same payout. Requires handling `PayoutStarted` (currently `[]`). | `types-lookup.ts:4367` **[V]** |
| Are genesis balances seeded? | **No — not at all.** `genesisHandler` creates Accounts, Identities, Portfolios, MultiSigs and Permissions, but no balances. Any derived-balance model must add a genesis snapshot or every balance is wrong by the genesis allocation. | `src/mappings/migrations/genesisHandler.ts` **[V]** |
| Is fixing `Identity.secondaryAccounts` semantics breaking? | **No.** The SDK reads secondary keys from **chain** (`polymeshApi.query.identity`), not middleware. No consumer queries the field. | `polymesh-sdk` `src/api/entities/Identity/index.ts:865+` **[V]** |
| Can `store.getByFields` replace the custom `getPaginatedData`? | **Yes.** Available with `{ limit, offset, orderBy, orderDirection }`. | `@subql/types-core/dist/store.d.ts:32` **[V]** |
| Is the `OR`-across-from/to query pattern real, or theoretical? | **Real, and universal.** SDK `polyxTransactions`, portal `assetTransactions` (three grains), and Subscan all use it. Strongest evidence for the entry-centric ledger. | `consumer-queries.md` §2.1 **[V]** |
| Is portfolio-grain holding a real requirement? | **Yes, live in production.** The portal filters `fromPortfolioId`/`toPortfolioId`. | `graphqlQueries.ts:29-33` **[V]** |
| Is aggregation available, and is it used? | **Both.** `aggregate` defaults to `true`, pg-aggregates is bundled and patched for BigInt precision — and the SDK already uses `groupedAggregates`. | query image `dist/yargs.js:18`; SDK `claims.ts:96` **[V]** |
| Do jsonField filters work for consumers? | **Yes** — the SDK filters `scope: { contains: $scope }`. Makes the `locks`/`holds`/`lifetimeByKind` jsonField proposals viable. | SDK `claims.ts:35` **[V]** |
| Is a cross-account lock query needed (jsonField vs. table)? | **No consumer queries locks at all** → jsonField is safe. | `consumer-queries.md` §4 |
| Does "transfers" mean `kind = Transfer` only? | **No.** `polyxTransactions` applies no kind filter; consumers want all movements. | SDK `polyxTransactions.ts` **[V]** |
| Is `api` inside a handler block-scoped? | **Yes.** `getPatchedApi` builds `api.at(currentBlockHash)` and injects the block hash into historic RPC params. Docs confirm: "Methods accepting `BlockHash` parameters use current indexing block hash by default." (Retracted an earlier incorrect finding.) | `@subql/node` `api.service.js:230-283`; SubQuery Polkadot mapping docs **[V]** |
| Can event handlers be bound to spec-version ranges declaratively? | **No.** `specVersion` filtering exists on **block handlers only**; event handlers filter on `module`/`method` alone. Version dispatch must stay in code — which is what the name-based decode design does. | SubQuery Polkadot manifest docs **[V]** |
| Can we index a Boolean field? | **No** — `@index` is unsupported on Boolean and JSON fields, and `@compositeIndexes` caps at 3 columns excluding Boolean/JSON. Two proposals were corrected to use nullable relations instead. | SubQuery GraphQL reference **[V]** |
| Can the `padId` zero-padding be retired? | **No — it must be kept.** The SDK orders `polyxTransactions` by the padded composite id *deliberately*, because ordering by `createdBlockId` alone leaves same-block rows unordered and makes pages repeat or skip entries. The portal has removed its `paddedIds` flag and now depends on it unconditionally. | SDK `origin/develop` `polyxTransactions.ts:59-66`; portal `origin/main` **[V]** |
| Did `FungibleTokensMovedBetweenPortfolios` / `NFTsMovedBetweenPortfolios` ever fire? | **Effectively no.** Mainnet: 0 and 0. Testnet: 0 and **1** (block 7,786,536, spec 5003001). Controls non-zero, so the query shape is right. No mainnet history is missing — A8 severity downgraded. | mainnet + testnet SubQuery dictionaries **[V]** |
| What is the entry-centric row amplification? | **1.035× mainnet, 1.006× testnet** — not the 1.2–1.3× I estimated. 61% of mainnet rows are single-sided staking rewards. The row-count objection does not survive the data. | mainnet + testnet middleware **[V]** |
| Is a row-per-NFT entity viable? | **Yes, comfortably.** ~6,200 NFTs on mainnet (6 collections, 617 holders), ~10,700 on testnet. Thousands, not millions. | mainnet + testnet middleware **[V]** |
| Are unfiltered aggregates safe on large tables? | **No — they fail, not just slow down.** `groupedAggregates` over mainnet `polyxTransactions` (5M rows) returns Postgres `57014` statement timeout. Consumers must always filter. | mainnet middleware **[V]** |
| Is the deterministic sub-index for new ledger entries optional? | **No, required** — same reason as above. Settles `polyx-balance-model.md` §7.6 Q9. | as above **[V]** |

---

## Questions still open

Ordered by how much they change the plan.

**No blocking questions remain.** All four that previously sat here are resolved: reindex budget (D5), corporate-actions scope (D6), fiat valuation (D7), and the A8 impact count.

### Answerable with a database, not a decision

I can settle these given query access; none need product judgement.

1. **Do balance mutations exist with no event?** Determines whether reconciliation is a safety net or load-bearing. Best settled empirically via Phase-1 mismatch rates rather than by reading Rust exhaustively.

### Needs information I do not have locally

2. **`polymesh_private_dev` spec offsets** (2_000_000 / 2_001_000 / 2_002_000) are internally consistent but unverified against the private chain's actual release history.

---

## Current state at a glance

**Confirmed defects:** 12 (A1–A12). Two return silently wrong data to consumers: A12 (claim issuer collision, compliance path) and A9 (v8 `reserved` entirely unindexed).

**Coverage:** three pallets have zero handled events — `corporateAction`, `corporateBallot`, `checkpoint`. Roughly 150 events are registered as `[]`.

**Schema:** 67 entities; 28 observably consumed. 1,148 hand-maintained enum values make up ~53% of `schema.graphql`. Zero composite indexes.

**The through-line:** most findings trace to three patterns — shape knowledge living in handler bodies instead of a table, holdings stored at a *derived* grain rather than the finest one the chain uses, and coverage gaps that nothing surfaces. The settlement domain already solves all three and is the internal template worth copying.
