# Polymesh SubQuery — Indexer Review

Audit and redesign proposals for the Polymesh indexer.

Reviewed on branch **`alpha`**, cross-referenced against `PolymeshAssociation/Polymesh` tags `v4.1.x`–`v8.0.2`, the deployed `onfinality/subql-query:v2.25.0` image, `polymesh-types@7.4.0`, `polymesh-sdk`, and `polymesh-portal`.

Claims are tagged **[V]** (verified against source) or **[I]** (inference needing confirmation).

> **Revision, 2026-09-01.** The review was written against the tree at `7fbb8bb` and has been brought forward onto `alpha` at `0f4f337`, which adds PRs [#342](https://github.com/PolymeshAssociation/polymesh-subquery/pull/342) (`revive.ethTransact` sender recovery) and [#343](https://github.com/PolymeshAssociation/polymesh-subquery/pull/343) (authorization payload repair), and six new operational findings. **[`CHANGES.md`](./CHANGES.md) is the supplement** — every amendment in this revision with its reasoning, in one place. Read it if you read the review before 2026-09-01.

---

## How to read this

| Document | What it covers | Read it when |
|---|---|---|
| **[architecture-review.md](./architecture-review.md)** | How the indexer is *built* — version handling, decoding, enum codegen, indexes, aggregation, rollups, testing, sequencing | Planning the work |
| **[entity-review.md](./entity-review.md)** | The *data model* — all 69 entities by domain, each judged against the use case it serves | Deciding what to change |
| **[implementation/](./implementation/README.md)** | Thirteen plans: schema diffs, handler changes, `project.ts`, tests, consumer impact | Doing the work |
| [reference/defect-log.md](./reference/defect-log.md) | Confirmed defects (A1–A16) and fragile patterns (B1–B9) | Fixing something specific |
| [reference/event-shape-verification.md](./reference/event-shape-verification.md) | Event-by-event shape comparison v4.1.3 → v8.0.2 for every planned domain | Writing a decoder |
| [reference/consumer-queries.md](./reference/consumer-queries.md) | What the SDK and portal actually query, and what that evidence settles | Judging blast radius |
| [reference/polyx-balance-model.md](./reference/polyx-balance-model.md) | Ground-up POLYX balance design | Working on balances |
| [reference/identity-asset-model.md](./reference/identity-asset-model.md) | Ground-up identity/key and asset-lifecycle design | Working on identities or assets |
| [CHANGES.md](./CHANGES.md) | Every amendment made in the 2026-09-01 revision, with reasoning | You read the review before 2026-09-01 |

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
| D8 | **Every timestamp column becomes `timestamptz`.** | 2026-09-01 | Times are UTC today but serialize without a zone marker, so a consumer parsing `"2021-11-05T13:56:36"` as local time shifts silently by its own offset. `timestamptz` makes GraphQL emit `+00:00`. No schema field changes and no new fields — only the serialized string changes. Breaking for anything doing exact string comparison on a datetime; accepted under D1. The **companion question — whether to also expose an epoch integer — is deliberately left open**, with the trade-off written up in `architecture-review.md` §10.2. |
| D9 | **An arbitrary `START_BLOCK` is a supported mode, not a dev flag.** | 2026-09-01 | The indexer seeds entity state from chain storage at the start block and records what it seeded in an `IndexOrigin` entity; accumulating writes refuse to run over an unseeded domain rather than accumulating from zero. Plan [10](./implementation/10-partial-index.md). The alternative — upsert everywhere, no seeding — was rejected because it converts a loud stall into a silently wrong total. |
| D10 | **Chain storage reads are type-augmented from `polymesh-types`, replacing `@polkadot/api-augment`, with a named escape hatch for removed storage.** | 2026-09-01 | Prototyped end-to-end and reverted, so the cost is measured **[V]**. `@polkadot/api-augment` describes the generic *kitchensink* runtime; loading both makes import order silently decide which chain 161 members describe, so it must be replaced rather than supplemented (its runtime half, `@polkadot/types-augment`, imported directly). Five call sites to fix; two are pre-7.x storage names, the structural tension being that the package augments *one* metadata while an indexer reads *all* of them. Plan [12](./implementation/12-types-and-ci.md). |
| D11 | **Correctness of accumulated POLYX is verified against chain state, not asserted.** | 2026-09-01 | POLYX rows are used for accounting, and pre-v8 events do not carry enough to attribute every movement — `rewardDestination` is recorded as `LegacyUnknown` for every pre-8.x staking reward **[V]**. A reconciliation harness against public archive endpoints is a deliverable of plan [02](./implementation/02-polyx-ledger.md), not a follow-up. |
| D12 | **Chain-assigned numeric ids are zero-padded like block ids.** | 2026-09-01 | `Instruction.id` is the chain's own sequence stored as a `String` **[V]**, so `orderBy: ID_DESC` sorts it lexicographically — `9999` before `14712`. Extends D4 from composite ids to bare numeric ones. |

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

**Added 2026-09-01:**

| Question | Answer | Evidence |
|---|---|---|
| Does `START_BLOCK > 1` work? | **No, in two independent ways.** The genesis datasource declares `[1,1]` alongside `[startBlock,∞)`, a range the node will not cover; and every handler that modifies an existing entity meets an empty database. | `project.ts:459-490`; `mapNfts.ts`, `mapSettlement.ts`, `mapStatistics.ts` **[V]** — plan [10](./implementation/10-partial-index.md) |
| Can a handler read chain storage *as of the block it is indexing*? | **Yes**, and that is what makes seeding at an arbitrary start block possible. `getPatchedApi` builds `api.at(currentBlockHash)`; `.at`/`.entriesAt` called explicitly remain unsupported. | `@subql/node` `api.service.js:230-283` **[V]** |
| Does augmenting chain types with `polymesh-types` break the build? | **No, but it is not one line.** The naive version yields **454** errors in four classes; done properly (import `types-lookup` first, drop `@polkadot/api-augment`, keep its runtime half, `skipLibCheck`) it costs **five** call-site fixes and the full gate is green. | prototyped and run, then reverted, 2026-09-01 **[V]** — plan [12](./implementation/12-types-and-ci.md) §12.2 |
| Is the polkadot-js CJS/ESM dual-declaration split what breaks augmentation here? | **No, though it is real.** `@polkadot/api-base` ships `types/storage.d.ts` and `cjs/types/storage.d.ts`, and `moduleResolution` decides which one polymesh-types augments. Augmentation survives both modes because resolution is self-consistent within a program; the hazard is a **mixed-mode** build, so `moduleResolution` is now pinned. | `--traceResolution` under `node` and `node16` **[V]** |
| Why did type-checking appear broken? | **`src/types` is gitignored** — it is `subql codegen` output. A fresh checkout reports 11 "no exported member" errors until `yarn codegen` runs. After codegen the baseline is clean. There is also no `typecheck` script, and `eslint` is configured without `parserOptions.project`, so it carries no type information at all. | `.gitignore`; `.eslintrc`; `package.json` **[V]** |
| Are pre-v8 staking rewards attributable to the account that received them? | **No.** `getLegacyStakingEventDetails` sets `rewardDestination: 'LegacyUnknown'` — the pre-8.x event carries only the stash, and the payee was never read from storage. Honest, but it means no pre-v8 reward row can say where the POLYX went. | `mapStakingEvent.ts:110-130` **[V]** |
| Is the `blocks` table a freshness signal? | **No.** `mapBlock` is called from `handleEvent`, not a block handler, so a block that produced no handled event gets no row. `MAX(block_id)` can sit behind the head while the indexer is current; `_metadata.lastProcessedHeight` is the signal. | `mappingHandlers.ts:45-52` **[V]** |
| Is internal paging deterministic? | **No.** `getPaginatedData` sets `orderBy` to the column it is filtering on, so every row in the set shares that value and the order is not total. Offset paging over it can repeat and skip rows. | `common.ts:325-350` **[V]** — plan [11](./implementation/11-throughput.md) §11.3 |
| Are `revive.ethTransact` senders and pre-migration authorization payloads still open? | **No — both shipped.** PR #342 recovers the Ethereum sender and adds `EvmTransaction`/`EvmAccountMapping`; PR #343 repairs authorization payloads that still name a ticker, forward and by backfill. | `alpha@0f4f337` **[V]** |

---

## Questions still open

Ordered by how much they change the plan.

**No blocking questions remain.** All four that previously sat here are resolved: reindex budget (D5), corporate-actions scope (D6), fiat valuation (D7), and the A8 impact count.

### Needs a decision, not evidence

1. **Should timestamps also be exposed as an epoch integer alongside `timestamptz`?** D8 settles the correctness half. The integer is a separate question — a second representation of the same fact, on every ordered entity, when the padded composite id already provides deterministic ordering. Pros and cons written up in [`architecture-review.md`](./architecture-review.md) §10.2; **no recommendation is made here**, deliberately.

2. **Is staking history this indexer's job, or should it stay focused on the securities domain?** Every route to fixing A15 is a step toward a `StakingPosition` / `Nomination` / `Validator` / `Era` model that does not exist today (`staking` is 8/32 handled). The middle line the plans currently assume — index enough staking to make the **POLYX ledger** attributable, and treat validator/nomination/era modelling as a separate later decision — is an assumption, not a decision. Argument both ways in [`implementation/02-polyx-ledger.md`](./implementation/02-polyx-ledger.md); it should be settled before plan [07](./implementation/07-staking.md) is sized.

### Answerable with a database, not a decision

3. **Do balance mutations exist with no event?** Determines whether reconciliation is a safety net or load-bearing. Best settled empirically via Phase-1 mismatch rates rather than by reading Rust exhaustively. The reconciliation harness in plan [02](./implementation/02-polyx-ledger.md) is what answers it.

4. **How large is the pre-v8 staking-reward attribution gap in practice?** `rewardDestination` is `LegacyUnknown` for every pre-8.x reward **[V]**, but the share of stakers who set a payee other than their stash is unmeasured. If it is near zero the gap is cosmetic and `LegacyUnknown` documented in the schema is a defensible answer; if it is material, one of the two recovery routes in plan [02](./implementation/02-polyx-ledger.md) is warranted. Measurable from public archive endpoints.

5. **How slow is a slow block in wall-clock terms?** The mechanism is now established and quantified — testnet block 15,391,572 writes ~1.16M integers to delete 399 NFT ids **[V]** — but no timing has been taken. Two testnet replay fixtures are identified in plan [11](./implementation/11-throughput.md) §11.1; the mainnet equivalents are not.

### Needs information I do not have locally

6. **`polymesh_private_dev` spec offsets** (2_000_000 / 2_001_000 / 2_002_000) are internally consistent but unverified against the private chain's actual release history.

---

## Current state at a glance

**Confirmed defects:** 16 (A1–A16). Two return silently wrong data to consumers: A12 (claim issuer collision, compliance path) and A9 (v8 `reserved` entirely unindexed). A13–A16 were added in the 2026-09-01 revision — non-deterministic internal paging, lexicographic ordering of numeric ids, unattributable pre-v8 staking rewards, and timezone-ambiguous timestamps.

**Coverage:** three pallets have zero handled events — `corporateAction`, `corporateBallot`, `checkpoint`. `relayer` is a fourth, with 8 calls and no entity. Roughly 150 events are registered as `[]`.

**Schema:** **69** entities (67 plus `EvmTransaction` and `EvmAccountMapping` from PR #342); 28 observably consumed. 1,148 hand-maintained enum values make up ~53% of `schema.graphql`. Zero composite indexes *declared in the schema* — 30 indexes including composites exist in `db/compat.sql`.

**The through-line:** most findings trace to four patterns — shape knowledge living in handler bodies instead of a table, holdings stored at a *derived* grain rather than the finest one the chain uses, coverage gaps that nothing surfaces, and **orderings that are not total**, which make paging repeat and skip rows in three separate places. The settlement domain already solves the first three and is the internal template worth copying; the fourth is a rule (D4, D12, plan [11](./implementation/11-throughput.md) §11.3) rather than a domain.
