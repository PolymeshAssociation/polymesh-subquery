# Polymesh SubQuery — Architecture Review & Redesign Proposals

Part of the [indexer review](./README.md). Companion to [`defect-log.md`](./reference/defect-log.md) (concrete defects). This document is about **patterns**: what the current design gets wrong structurally, what a from-scratch design would look like, and what to build so future chain upgrades cost hours instead of weeks.

Measured on branch `alpha`.

---

## 1. Where the pain actually is

Four numbers explain most of the maintenance burden:

| Metric | Value |
|---|---|
| Entities | 67 |
| Hand-maintained enum values (`ModuleIdEnum` 67 + `EventIdEnum` 503 + `CallIdEnum` 578) | **1,148** |
| Share of `schema.graphql` that is hand-written enums (lines 4–1752 of 3,300) | **~53%** |
| Indexes declared in `schema.graphql` / in raw SQL (`db/compat.sql`) | 95 / **30** |

Every chain release requires a human to: read the runtime diff, hand-edit three giant enums in `schema.graphql`, hand-write `ALTER TYPE "<hashed>" ADD VALUE ... AFTER '<neighbour>'` migrations in order, add `project.ts` filter rows, and then add version branches inside handlers. That process has already leaked a typo into production (`sumbit_unsigned`, fixed by migration 16) and produced the mis-decodes in the audit doc.

**The root cause of every version bug found so far is the same: shape knowledge lives inside handler bodies as positional destructuring, with no arity assertion and no per-version test.**

---

## 2. Current version-handling pattern — and why it fails

Today, version awareness is four predicates in [`src/utils/common.ts`](../src/utils/common.ts) (`is7xChain`, `is7Dot3Chain`, `is8xChain`, plus the value-sniffing `extract8xStakingAmount`) called ad hoc from ~20 sites, mixed with bare numeric comparisons (`specVersion < 5004001`, `>= 6000000`, `6001000..6003001`).

Failure modes this produces, all observed:

1. **Silent misdecode on an unanticipated shape.** A new event variant (`TransferWithMemo`, 4 named fields) hits a handler whose `else` branch assumes the legacy 6-positional layout. Nothing throws; garbage rows are written. (Audit A2)
2. **Off-by-one with no signal.** `params[4]` on a 4-param event yields `undefined → BigInt(0) → falsy`, and the row is silently skipped. (Audit A1)
3. **Guard drift.** A range check written for 6.1–6.3.1 that actually evaluates true forever because of `||` vs `&&`. (Audit A4)
4. **Registration without implementation.** `project.ts` names a handler that doesn't exist. Nothing checks this at build time. (Audit A3)
5. **Knowledge scattered.** To answer "what shape does `balances.Transfer` have at spec 7.4?" you must read handler bodies, not a table.

### The fix: decode by field name first, version table only for legacy tuples

An earlier revision of this section proposed a hand-maintained `{ range: [min,max], decode }` registry for every event. **That over-engineers the common case.** Since Metadata v14 the runtime metadata is self-describing: polkadot-js already decodes `event.data` correctly per block using that block's own metadata, and — critically — **struct-style events carry field names in the metadata**. This is why the manually-curated `polymesh-types` definitions matter far less than they used to.

The codebase already straddles this boundary in [`mapEvent.ts`](../src/mappings/entities/events/mapEvent.ts):

```ts
const typeName = genericEvent.meta.fields[i].typeName;
if (typeName.isSome) { /* metadata >= v14 */ } else { /* metadata < v14 */ }
```

`meta.fields[i].name` is `Some` for struct-style events and `None` for tuple-style ones. That maps almost exactly onto the era split:

| Era | Event style | Decode strategy |
|---|---|---|
| v8.x (upstream pallets) | struct — `Transfer { from, to, amount }` | **by name** |
| v7.x Polymesh structs — `Bonded { identity, stash, amount }`, `TransferWithMemo { from, to, amount, memo }` | struct | **by name** |
| ≤ v7.x tuple events — `Transfer(Option<IdentityId>, AccountId, …)` | tuple, no names | positional + **asserted arity**, version-keyed |

So the design becomes:

1. **Primary path — named-field access.** `field(params, meta, 'amount')` resolves via metadata. Immune to field insertion/reordering, and immune to the whole class of bug in A1/A2. Every 7.x-and-later struct event is covered with no version table at all. `TransferWithMemo` would simply have worked.
2. **Fallback path — a small version-keyed table for legacy tuple events only.** These are *frozen history*: pre-7.x shapes will never change again, so the table is written once and stops growing. This is where `range` + asserted `arity` earns its keep.
3. **Hard failure on ambiguity.** Unknown field name, no matching range, or arity mismatch → throw + write an `IndexerAnomaly` row (§4.3). Never a silent `undefined → BigInt(0)`.
4. **Private-chain offsets normalized once**, before any lookup, instead of being repeated inside every `isXxxChain` predicate.

Net effect: the maintained surface shrinks from "a decoder per event per version" to "a frozen legacy table plus a name-based accessor", and new chain releases mostly require **no decoder work at all** — which is the actual goal.

### Optional second step: block-range data sources

SubQuery supports multiple `dataSources` each with `startBlock`/`endBlock` — the repo already uses this for the genesis-only source (`startBlock: 1, endBlock: 1`). Version-specific handlers can be bound to block ranges so the runtime never branches at all.

Caveat worth stating plainly: **spec version is not block number.** This requires a maintained spec→block-range table per network (mainnet/testnet/private), and it must be regenerated when a chain forks or a new network is added. Recommendation: adopt the decoder registry first (network-independent, correct everywhere), and only consider range-bound data sources afterwards if profiling shows the branch cost matters. It almost certainly won't.

---

## 3. Automate the enums (highest ROI change)

**Proposal: `scripts/sync-metadata.ts`** — reads runtime metadata and regenerates enums + migrations mechanically.

Inputs: a node WS endpoint (or a checked-in `metadata.json` per spec version, which `polymesh-types` already maintains).

Steps:
1. Fetch metadata for target spec version; extract every pallet, event, and call.
2. Diff against the previous snapshot (committed under `metadata/<specVersion>.json`).
3. Regenerate the `ModuleIdEnum` / `EventIdEnum` / `CallIdEnum` blocks in `schema.graphql` in **deterministic (alphabetical) order**.
4. Emit `db/migrations/<n>_spec_<version>.sql` with the `ALTER TYPE … ADD VALUE … AFTER …` statements, computing each `AFTER` neighbour automatically from the existing order.
5. Emit a stub `project.ts` filter block for newly discovered events, defaulting to `[]` (captured generically, no specific handler) so nothing silently disappears.
6. Emit a **report of newly added or changed events** — the human-review artifact that tells you which handlers need attention this release.

Notes:
- Step 6 is the piece that would have caught `TransferWithMemo` at 7.4.0 the day it landed.
- `polymesh-types` already has `scripts/fetchDefinitions.ts` and `scripts/diff_versions.ts` plus `spec_diffs/` through `8000000-8999999`. Reuse rather than rebuild; consider publishing the extraction as a shared package consumed by both repos.
- Enum **ordering** is only load-bearing because the current migrations use positional `AFTER`. Generating alphabetically and computing neighbours removes the class of error entirely.
- Also delete this repo's stale `spec_diffs/` (stops at 5003000) — see audit B7.

**Related, cheap, high value:** add a build-time check that every handler name referenced in `project.ts` is actually exported from `src/index.ts`. That is ~15 lines and permanently closes audit A3.

---

## 4. Entity model review

### 4.1 Indexing: not missing, but split across two sources of truth

> **Correction.** An earlier revision claimed `Event` had no indexes on its filter columns and that the project had zero composite indexes. **Both were wrong** — true of `schema.graphql`, false of the deployed database. [`db/compat.sql`](../db/compat.sql) creates **30 indexes** in raw SQL, including everything I said was missing.

What `compat.sql` already provides **[V]**:

```sql
CREATE INDEX ... ON events (module_id);
CREATE INDEX ... ON events (event_id);
CREATE INDEX ... ON events (module_id, event_id);                              -- composite
CREATE INDEX ... ON events (module_id, event_id, left(event_arg_2, 100));      -- 3-col composite
CREATE INDEX ... ON events (left(event_arg_0, 100));   -- ... through event_arg_3
CREATE INDEX ... ON events (claim_type); (claim_scope); (claim_issuer); (spec_version_id);
CREATE INDEX ... ON extrinsics (module_id); (call_id); (address); (signed);
CREATE INDEX ... ON events (trim('"' from attributes #>> '{2,value,did}'));    -- JSONB expression
```

It also adds **generated JSONB columns**, which likewise means the "`attributesTxt` → `jsonb`" recommendation was already implemented:

```sql
ALTER TABLE events     ADD COLUMN IF NOT EXISTS attributes JSONB GENERATED ALWAYS AS (attributes_txt::jsonb) STORED NULL;
ALTER TABLE extrinsics ADD COLUMN IF NOT EXISTS params     JSONB GENERATED ALWAYS AS (params_txt::jsonb)     STORED NULL;
```

**The real problem is structural, and it is what let me get this wrong:**

1. **Two sources of truth.** Indexes live in `schema.graphql` (`@index`, 95 of them) *and* in `db/compat.sql` (30, hand-written). Anyone reviewing the schema sees half the picture. A schema-level reviewer — human or tooling — cannot answer "is this column indexed?" from one file.
2. **The startup race.** `docker-entrypoint.sh` applies it backgrounded, with a self-kill on failure: `(npm run sql || (sleep 3 && kill "$$")) &`. It races the SubQuery node creating the tables it depends on; losing the race kills the container. Meanwhile `npm run migrations` runs **synchronously before** the node starts, so the two mechanisms have opposite ordering semantics.
3. **Re-application on every deploy.** SubQuery regenerates tables from `schema.graphql`, so these artifacts must be re-applied each time and can silently drift.

Recommendations, revised:
- **Migrate what the directives can express into `schema.graphql`** — plain and composite indexes become `@index` / `@compositeIndexes(fields: [["moduleId","eventId"]])`, subject to the 3-column cap and the Boolean/JSON exclusion (§8b).
- **Keep `compat.sql` only for what directives cannot express**: expression indexes (`left(event_arg_0, 100)`), generated columns, and the JSONB path index. Document *why* each one lives there.
- **Fix the startup ordering** so index/column creation is deterministic rather than a race.
- For genuinely new entities (`PolyxEntry`, `Holding`), declare indexes in the schema from the start rather than adding a second SQL layer.
- **Measure before adding anything new.** Indexes on the hottest write path cost sync throughput and disk — a deliberate read/write tradeoff, not a free win.

### 4.2 Merge candidates

**The headline merge — `PortfolioMovement` → `AssetTransaction`.** Written up in full in Francis's *One Movement Ledger* draft, and it should be treated as the primary entity-model change rather than one item among many. Summary of why it holds: `AssetTransaction` already carries the from/to portfolio-account-identity triples, asset, amount, `nftIds`, an `eventId` discriminator and an instruction link — `PortfolioMovement` is a near-duplicate with `memo` and `address` added. The two tables provably do **not** overlap, because every writer of `PortfolioMovement` (`portfolio.FundsMovedBetweenPortfolios`, `portfolio.MovedBetweenPortfolios`, `settlement.FundsTransferred`) is intra-Identity, and intra-Identity movement emits no `AssetBalanceUpdated` (`Asset::transfer_holders_balance` deposits no event). So `AssetTransaction` is today an *incomplete* movement ledger, and filling the gap cannot double-count. Phased additive → deprecate → remove, with `Leg` deliberately left alone as *intent* rather than *effect*.

Other candidates:

| Entities | Rationale |
|---|---|
| `TickerExternalAgent`, `TickerExternalAgentAction`, `TickerExternalAgentHistory` | Three entities for one concept (agent membership + its history). Also `Ticker`-prefixed naming is stale post-7.x assetId migration. Merge into `AssetAgent` + `AssetAgentHistory`. |
| `TransferManager` vs `StatType` / `TransferCompliance` / `TransferComplianceExemption` | `TransferManager` is the pre-v5 model; the `StatType`/`TransferCompliance` set is the v5+ model for the same domain. Both are written unconditionally today. Consolidate behind one `TransferRestriction` model with an explicit era discriminator. |
| `Funding`, `Investment`, `DistributionPayment` | Each is already accompanied by an `AssetTransaction` row for the same movement, each holding a little extra context. Once the ledger merge lands, the open design question is whether these become satellites keyed to the ledger row or stay standalone. (Francis's open question 4 — same question one level out.) |
| `AssetHolder` / `NftHolder` | Same shape, different asset class. Could unify as `Holding { kind }`. Counter-argument: separate tables keep NFT queries cheap. Decide on measurement — noted as a candidate, not a recommendation. |
| `Debug`, `FoundType` | Development instrumentation living in the production schema. Move behind a flag or drop. |

### 4.3 Entities worth adding

- **`ChainUpgrade`** — persist `(specVersion, transactionVersion, firstBlock, datetime)`. Currently spec transitions are only `logger.info`'d and upgrade detection relies on module-level mutable state that breaks under `--workers` (audit A5). Persisting this also gives every backfill/audit a spec→block map for free, which is precisely what §2's optional block-range dispatch needs.
- **`IndexerAnomaly`** — one row whenever a decoder falls back, an enum resolves to `Unknown`, arity mismatches, or a referenced entity is missing. This converts today's silent corruption into a queryable defect list. Highest-value new entity in this document: every bug in the audit would have appeared here on day one.
- **Rollup/aggregate entities** — e.g. daily POLYX volume per address, holder counts per asset. Currently these require full scans at query time.

### 4.5 Redesigning the POLYX balance ledger

Audit A6 establishes the diagnosis: `PolyxTransaction` has **one** `type` column, but a balance movement has **two sides that can sit in different pools**, and `BalanceTypeEnum` mixes real pools (`Free`, `Reserved`) with a lock-floor (`Locked`) and staking-ledger states (`Bonded`, `Unbonded`) that never leave `free` at all.

**Proposed shape — double-entry, explicit on both sides:**

```diff
  type PolyxTransaction @entity {
    address: String        # from account
    toAddress: String      # to account
    amount: BigInt!
-   type: BalanceTypeEnum!
+   "pool the amount left; null = entered the system (mint/endow/reward)"
+   fromType: BalanceTypeEnum
+   "pool the amount entered; null = left the system (burn/slash/fee)"
+   toType: BalanceTypeEnum
  }
```

`BalanceTypeEnum` narrows to what actually exists as a pool: `Free`, `Reserved`, and — kept deliberately, as *derived* staking-ledger buckets rather than balances-pallet pools — `Bonded`, `Unbonded`. `Locked` leaves the movement ledger entirely (see below).

Applying it to the verified chain semantics:

| Event | Chain effect | `fromType` → `toType` |
|---|---|---|
| `balances.Transfer` | free → free, across accounts | `Free` → `Free` |
| `balances.Endowed` | account created | `null` → `Free` |
| `balances.Reserved` | `free -= v; reserved += v` | `Free` → `Reserved` |
| `balances.Unreserved` | `reserved -= v; free += v` | `Reserved` → `Free` |
| `balances.ReserveRepatriated` | reserved → dest pool, across accounts | `Reserved` → `Free`\|`Reserved` per status |
| `balances.Burned` / `Slashed` / `Withdraw` | leaves issuance | `Free` → `null` |
| `balances.Minted` / `Deposit` / `Restored` | enters issuance | `null` → `Free` |
| `staking.Bonded` | free locked into staking ledger | `Free` → `Bonded` |
| `staking.Unbonded` | active → unlocking queue | `Bonded` → `Unbonded` |
| `staking.Withdrawn` | **leaves** unlocking queue, "frees up that balance" | `Unbonded` → `Free` |
| `staking.Rewarded` | new issuance to stash | `null` → `Free` |
| `protocolfee.FeeCharged`, `transactionpayment.TransactionFeePaid` | fee leaves payer | `Free` → `null` |

With this, every pool balance becomes derivable — `SUM(amount) WHERE toType = X` minus `SUM(amount) WHERE fromType = X` — which is impossible today. Note in particular that `Withdrawn` flips from a spurious second credit to `Unbonded` into the debit that finally lets the unbonding queue drain.

**Lock and freeze events do not belong in a movement ledger.** `balances.Locked` / `Unlocked` / `Frozen` / `Thawed` set or clear a *floor* on `free` (`misc_frozen` / `fee_frozen`); no balance moves. Recording them as `PolyxTransaction` rows asserts a movement that never happened. They should become a separate `BalanceLock` entity (account, reason, amount, set/cleared, block) — which is also the more useful shape for anyone asking "why can't this account transfer".

**Migration note:** this is breaking for consumers reading `type`. A staged path is to add `fromType`/`toType` alongside `type`, backfill them from `(eventId, type)` using the table above, let consumers migrate, then drop `type` in a major release — the same additive → deprecate → remove shape as the ledger merge.

**Correct before redesigning:** `staking.Withdrawn` is wrong under the *current* schema too (it should not be a credit to `Unbonded`). That is a small, self-contained fix worth landing independently of the model change.

### 4.4 Naming debt

Post-7.x the chain identifies assets by UUID, but the schema still carries `ticker`-shaped names: `Event.corporateActionTicker`, `Event.fundraiserOfferingAsset`, the `TickerExternalAgent*` family, and various `ticker` fields now nullable-but-present. A from-scratch design uses `assetId` throughout with `ticker` as an optional legacy attribute on `Asset` only.

---

## 5. Handler-layer patterns

**Keep and extend — these are already good:**
- `extractArgs()` normalizing `SubstrateEvent` into `HandlerArgs`.
- `toEnum(EnumType, value, Unknown)` graceful degradation, plus preserving the raw string in `eventIdText`/`moduleIdText`. Extend the same raw-text preservation to calls.
- Routing asset identity through shared `getAssetId`/`getAssetIdWithTicker` helpers — this is why the ticker→assetId migration is largely correct.

**Change:**
- **Assert arity at every positional decode.** Single highest-value code change; catches audit A1 and A2 outright.
- **Separate decode from business logic.** Handlers should consume DTOs (§2), never `params[i]`.
- **Never `BigInt(undefined) → 0` silently.** `getBigIntValue` should distinguish "absent" from "zero"; absent on a required field is an anomaly, not a default.
- **Replace value-sniffing with explicit typing.** `extract8xStakingAmount`'s all-digits regex currently also props up several 2-param balances events by coincidence (audit B1).
- **Remove module-level mutable state** (`mapChainUpgrade`) — unsafe under worker threads.
- **Reconsider blanket `.catch(logError)`** in `mappingHandlers.ts`: decode failures should fail loudly (or record an `IndexerAnomaly`), not be swallowed.

---

## 6. Testing strategy

Current state: 29 test files, but `tests/entities/*` are **GraphQL integration tests against a running indexer + live chain + DB**. Only one unit-test file exists (`tests/unit/confidentialAssetHandlers.test.ts`, added with the confidential-assets work).

That is why version-decode bugs survive: nothing tests a decoder in isolation, and the integration suite only runs against whatever chain version the local stack happens to be.

Proposal — **fixture-based decoder tests**:
1. Capture real event arguments from an archive node at each supported spec version, one JSON fixture per `(module, event, specVersion)`.
2. Assert `decode(fixture) === expected DTO` for every registered decoder range.
3. Add a **metadata contract test**: for each spec version with a checked-in `metadata.json`, assert that every registered decoder's declared `arity` matches the arity the metadata actually specifies. This mechanically detects "the chain changed a shape and we didn't notice" — as a unit test, with no chain running.

These are fast, hermetic, and would have caught every defect in the audit.

---

## 7. SubQuery capabilities not currently used

| Capability | Status | Note |
|---|---|---|
| `@compositeIndexes` | unused | §4.1 |
| Full-text search indexes | unused | Candidate for `Event.attributesTxt` if it becomes `jsonb` |
| Multi-datasource block ranges | used only for genesis | §2 optional step |
| Build-time handler-existence validation | absent | Closes audit A3 |
| Worker threads (`--workers`) | recently made configurable | Blocked in practice by module-level mutable state (audit A5) — fix before enabling widely |
| Bulk store ops (`store.bulkCreate` / `bulkUpdate`) | partially used (`bulkCreate('Leg', …)`) | Several handlers still do per-row read-modify-write |
| `store.getByFields` (multi-condition) | custom `getPaginatedData` used instead | Worth checking whether the built-in on `@subql/node` 6.x now covers this |
| Historical state tracking | left at default (enabled) | Significant write amplification; if the middleware never queries historical state, disabling is a large sync-speed win. Verify consumer requirements first. |

Also: `project.ts` metadata is still starter boilerplate (`name: 'polkadot-starter'`, `version: '0.0.1'`, runner `>=3.0.1` vs actual `@subql/node ^6.4.6`) — audit B5/B6.

---

## 8. If we were building this from scratch

Layering, outermost to innermost:

```
project.ts            generated filter table (from metadata), no hand edits
   ↓
dispatch              module/event → handler, validated at build time
   ↓
decoders/             versioned registry: (module, event, specRange) → DTO
                      arity-asserted, fixture-tested, no business logic
   ↓
handlers/             DTO → entity writes. No params[], no spec checks.
   ↓
store layer           bulk ops, idempotent upserts
   ↓
schema.graphql        generated enums + hand-authored entities w/ explicit indexes
```

Principles:
1. **Shape knowledge is data, not control flow.** A table keyed by spec range, not `if` statements in handlers.
2. **Unknown is recorded, never guessed.** New event, missing decoder, arity mismatch → `IndexerAnomaly` row + loud log. Never a silently wrong row.
3. **Generated artifacts are generated.** Enums and migrations come from metadata; humans review the diff, they don't type it.
4. **Every positional read asserts its arity.**
5. **Entities are named for the domain as it is now** (`assetId`), with legacy identifiers as explicit attributes.
6. **Indexes are declared from measured access patterns**, not omitted by default.

---

## 8b. SubQuery platform capabilities — what we can and cannot use

Audited against the official schema reference and the Polkadot mapping/manifest docs. Three of these correct assumptions made earlier in this review.

### Constraints that bound the design

| Constraint | Consequence |
|---|---|
| **`@index` is unsupported on Boolean and JSON fields** | Corrected two proposals in [`identity-asset-model.md`](./reference/identity-asset-model.md): `isActive` and `isBurned` are no longer indexed booleans. Use a **nullable relation** (`validToBlock`, `burnedBlock`) indexed via its FK and filtered with `isNull: true`. The existing schema has zero Boolean indexes, consistent with this. |
| **`@compositeIndexes` caps at 3 fields**, and excludes Boolean and JSON | The composite indexes proposed in §4.1 and `reference/polyx-balance-model.md` §8.6 all stay within 3 columns — but this must be checked before adding more. |
| **`specVersion` filtering is available on *block* handlers only** — event handlers filter on `module`/`method`, call handlers on `module`/`method`/`success`/`isSigned` | **This closes the §2 "optional second step" speculation.** Event handlers cannot be bound to spec-version ranges declaratively. Version dispatch must stay in code — which is exactly what the name-based decode plus frozen legacy table in §2 provides. Datasource-level `startBlock`/`endBlock` remains the only block-scoping mechanism (the repo already uses it for the genesis source). |
| **`api.query` targets the block being indexed; `.at`, `.entriesAt`, `.keysAt`, `.range` are unsupported** | Confirms the A5 retraction from another angle, and bounds the reconciliation design in `reference/polyx-balance-model.md` §3.4: state can be verified for the **current** block only, never for an arbitrary past one. |
| **Non-unique `@index` caps the result set at 100** | The likely reason `getPaginatedData` exists. Worth confirming this is the constraint before replacing it with `store.getByFields` — the built-in accepts `limit`/`offset`, so pagination is still the caller's job. |

### Capabilities available and currently unused

**`@fullText(fields: [...], language: "english")`** — zero uses today. Directly applicable to the searchable columns the schema already maintains for that purpose:

```graphql
type Event @entity @fullText(fields: ["eventArg_0", "eventArg_1", "eventArg_2", "eventArg_3"], language: "english") {
```

Also a candidate for `Asset.name`, `Portfolio.name`, and memo fields. Note the field-type restriction: `ID`, `String`, or foreign keys only.

**`@dbType(type: "Int")` on ID fields** — supports `BigInt`, `Int`, `Float`, `ID`, `String`. Narrowly useful, and explicitly **not** a route to removing `padId`.

> **Correction.** An earlier revision of this section proposed `@dbType` as a way to retire the zero-padding in [`src/utils/common.ts:14`](../src/utils/common.ts), on the grounds that the portal carried a `paddedIds` compatibility flag. Re-verified against the correct upstream branches (`polymesh-sdk` → `origin/develop`, `polymesh-portal` → `origin/main`), **both halves of that argument were wrong.**

The padding is **load-bearing for deterministic pagination**, and the SDK says so in a comment on `polyxTransactionsQuery` (`origin/develop`, `src/middleware/queries/polyxTransactions.ts:59-66`) **[V]**:

> `id` is the indexer's `<block number>/<event index>`, both zero padded, so it is unique and ordering it as a string orders by block and then by position within the block. Ordering by `createdBlockId` alone leaves transactions in the same block in no defined order, which makes pages repeat or skip entries

So `orderBy: [IdDesc]` on the padded **composite** id is the SDK's fix for a real pagination bug — pages repeating or skipping rows. The in-flight `origin/middleware-ordering` branch formalises this further behind an `orderByClause` helper, i.e. the SDK is moving **toward** depending on the scheme, not away from it.

And the portal no longer branches on `paddedIds` at all: on `origin/main` the flag is gone and the padded ordering is hardcoded (`orderBy: CREATED_EVENT_ID_DESC`, `CREATED_BLOCK_ID_DESC`). It is now an unconditional dependency rather than a compatibility shim.

**Consequences for the redesign:**
- **Keep the padded composite id scheme.** Removing padding without replacing the ordering key would silently reintroduce non-deterministic intra-block ordering in both consumers.
- `@dbType` cannot solve this: a numeric `Block.id` still gives no ordering *within* a block, which is exactly the failure the SDK comment describes. Composite ids must stay strings.
- Any new entity in this review that consumers will paginate (`PolyxEntry`, `Holding`, `IdentityKey`) **must** carry a padded, block-then-index composite id for the same reason — including the deterministic sub-index flagged in `reference/polyx-balance-model.md` §7.6 Q9.
- `@dbType` remains a minor, optional win for purely-numeric non-composite ids only. Low priority; not worth a breaking FK migration on its own.

**`@jsonField(indexed: false)`** — nesting and index control on JSON types. Relevant to the `locks` / `holds` / `lifetimeByKind` proposals, where the arrays are read whole and never filtered on.

### Already used correctly

`@entity`, `@jsonField`, `@index(unique:)`, `@derivedFrom`, enums, and the `"""docstring"""` convention (which the settlement domain uses well and other domains should copy). Many-to-many via an intermediate entity is the documented pattern and matches `AgentGroupMembership`.

---

## 9. Sequencing

Breaking changes are approved (see [`README.md`](./README.md) decision log), so the model work no longer needs additive staging. The binding constraint is now **backfill**, not schema compatibility: every item in Tiers 3–4 requires a genesis replay.

**Tier 0 — correctness, ship independently of any redesign**
1. **Claim issuer collision** — highest priority. The `Claim` id omits `issuer`, and the SDK filters by `issuerId`; both a lost claim and a spurious revocation return wrong answers to a compliance path. See [`consumer-queries.md`](./reference/consumer-queries.md) §3.
2. Defect-log A1 (`params[3]`), A3 (missing handler), A4 (`&&`), A7 (`ControllerTransfer` branch).
3. `staking.Withdrawn` direction (A6).
4. Register `Held` / `Released` — without them v8 `reserved` is entirely absent (A9).
5. **Retire stale `ChildIdentity` rows at the v8 boundary** — the chain removed all child identities in a silent storage migration with no events (A11).
6. `TransferWithMemo` routing decision (A2).

**Tier 1 — stop the bleeding on upgrades**
7. Build-time check: every `project.ts` handler name is exported.
8. Arity assertions on positional decodes.
9. `scripts/sync-metadata.ts` — enum + migration generation, plus the **"in enum, registered, not handled"** report.
10. `IndexerAnomaly` entity; wire decode fallbacks into it.
11. Persist `ChainUpgrade`; drop `mapChainUpgrade`'s module-level state. This is also the hook Tier-0 item 5 needs.

**Tier 2 — decode layer**
12. Name-based field access (§2) as the default accessor; freeze the legacy tuple table. Start with `balances` / `staking`.
13. Fixture + metadata-contract tests alongside each migrated module.
14. Replace `getPaginatedData` with `store.getByFields` (confirmed available with `limit`/`offset`/`orderBy`).

**Tier 3 — the model (breaking, needs backfill)**
15. **Entry-centric movement ledger** — the best-evidenced change in the review; three independent confirmations of the `OR`-across-from/to pattern.
16. **`Holding` at portfolio/account grain** — confirmed live requirement via the portal's `fromPortfolioId` filter.
17. **POLYX ledger**: `PolyxEntry` + `AccountBalance` replacing `PolyxTransaction` and `BalanceTypeEnum`.
18. **Genesis balance seeding** — hard prerequisite for 17; `genesisHandler` currently seeds no balances at all.
19. `IdentityKey` replacing `AccountHistory`; `Nft`, `AssetAllowance`, `AssetMetadata`.

**Tier 4 — coverage**
20. Corporate actions, checkpoints and ballots (0/18 handled across three pallets) — **in scope, low priority per D6**. Purely additive and dependency-free, so it can land in parallel whenever capacity allows.
21. Staking positions; `PayoutStarted` (also supplies `eraIndex`).
22. Index review with benchmarks; `attributesTxt` → `jsonb`; `@fullText` on the `eventArg_*` search columns (§8b).

**Not on the roadmap — considered and rejected**
- Retiring `padId` via `@dbType`. The padded composite id is load-bearing for deterministic pagination in both consumers; see the correction in §8b.
