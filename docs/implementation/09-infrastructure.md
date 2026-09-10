# 09 — Infrastructure

Prerequisite for most other plans. Ships no consumer-visible feature; delivers the decode layer, anomaly recording, upgrade tracking, and index consolidation everything else depends on.

**Entities:** `IndexerAnomaly` (new), `ChainUpgrade` (new), `Event`/`Extrinsic` (index consolidation), `Debug`/`FoundType` (removal).

---

## 9.1 Decode layer

Replaces positional destructuring in handler bodies. Design rationale in [`../architecture-review.md`](../architecture-review.md) §2.

**New:** `src/decode/`

```
src/decode/
├── field.ts        named-field access via metadata
├── legacy.ts       version-keyed table for pre-7.x tuple events
├── assert.ts       arity assertions
└── index.ts
```

### Named-field access (primary path)

Since Metadata v14 struct-style events carry field names. Every v7.x-and-later Polymesh struct event and all v8 upstream events are named **[V]**.

```ts
export function field<T>(event: SubstrateEvent, name: string): Codec {
  const { fields } = event.event.meta;
  const idx = fields.findIndex(f => f.name.isSome && f.name.unwrap().toString() === name);
  if (idx < 0) throw new FieldNotFound(event.event.section, event.event.method, name);
  return event.event.data[idx];
}
```

This alone would have prevented A1 and A2.

### Legacy tuple table (fallback)

Pre-7.x tuple events have no field names. These shapes are **frozen history** — the table is written once and stops growing.

```ts
registerLegacy('balances', 'BalanceSet', [
  { range: [0, 7_999_999], arity: 4, decode: ([did, who, free, reserved]) => ({ did, who, free, reserved }) },
]);
```

`resolve(module, event, specVersion)` throws `NoDecoderForSpecVersion` on no match and `ArityMismatch` on a param-count disagreement. Both write an `IndexerAnomaly`.

**Note:** event handlers cannot be filtered by `specVersion` in `project.ts` — that filter is block-handler only **[V]** (§8b). Version dispatch must live here, in code.

### Spec-version normalisation

Fold the `polymesh_private_dev` offsets (2_000_000 / 2_001_000 / 2_002_000) into one normalisation applied before any lookup, replacing their repetition inside `is7xChain` / `is7Dot3Chain` / `is8xChain`.

**[I]** Those offsets remain unverified against the private chain's release history — normalising them in one place at least makes a future correction a single edit.

### Migration approach

Per module, starting with `balances`/`staking` (most version churn). A handler is migrated when it no longer references `params[i]` and has fixture tests.

---

## 9.2 `IndexerAnomaly`

The highest-value new entity in the review: converts silent corruption into a queryable defect list.

```graphql
"""
Recorded whenever the indexer could not decode or resolve something.
A non-empty table after a full resync is a defect list, not noise.
"""
type IndexerAnomaly @entity {
  id: ID!                        # padded blockId/eventIdx/seq
  kind: AnomalyKind!  @index
  moduleId: ModuleIdEnum
  eventId: EventIdEnum
  "what was expected vs seen — arity, field name, entity id"
  detail: String!
  specVersionId: Int! @index
  block: Block!
  createdAt: Date!
}

enum AnomalyKind {
  ArityMismatch
  FieldNotFound
  NoDecoderForSpecVersion
  UnknownEnumValue
  MissingReferencedEntity
  BalanceReconciliationDrift
  HandlerError
}
```

Wire into: `toEnum` fallbacks (currently silently `Unknown`), decode failures, `getAsset` misses, and the reconciliation check in [02](./02-polyx-ledger.md).

**Acceptance:** after a full resync, review every distinct `(kind, moduleId, eventId)` — each is either a genuine chain oddity to document or a bug to fix.

---

## 9.3 `ChainUpgrade`

Replaces the module-level mutable state in `mapChainUpgrade.ts`, which is unsafe under `--workers` (each worker holds its own copy).

```graphql
type ChainUpgrade @entity {
  id: ID!                        # padded spec version
  specVersionId: Int! @index(unique: true)
  transactionVersion: Int!
  firstBlock: Block!
  datetime: Date!
}
```

Handler: on each block, compare `block.specVersion` against the latest persisted `ChainUpgrade`; on change, write a row.

Two things this unlocks:
- **A11** — crossing into spec ≥ 8_000_000 triggers the one-off `ChildIdentity` retirement (the chain deleted them in a silent storage migration **[V]**).
- A persisted spec→block map, useful for backfills and for any future block-range data sources.

`api.rpc.state.getRuntimeVersion()` is block-scoped **[V]**, so the existing call is correct — only the state handling changes.

---

## 9.4 Index consolidation

Today indexes live in **two** places: `schema.graphql` (95 `@index`) and [`db/compat.sql`](../../db/compat.sql) (30 raw SQL) — see [`../architecture-review.md`](../architecture-review.md) §4.1. Nothing reconciles them, and `compat.sql` is applied by a backgrounded process that races node startup and self-kills on failure.

**Move into `schema.graphql`** — plain and composite indexes the directives can express:

```graphql
type Event @entity @compositeIndexes(fields: [["moduleId", "eventId"]]) {
  moduleId: ModuleIdEnum! @index
  eventId: EventIdEnum!   @index
  specVersionId: Int!     @index
}

type Extrinsic @entity @compositeIndexes(fields: [["moduleId", "callId"]]) {
  moduleId: ModuleIdEnum! @index
  callId: CallIdEnum!     @index
  address: String         @index
}
```

**Dropped, not consolidated** (done in the Phase 6 identity/keys branch): the denormalised
`claimType` / `claimScope` / `claimIssuer` / `claimExpiry` / `corporateActionTicker` /
`fundraiserOfferingAsset` / `transferTo` columns on `Event`, plus their `compat.sql` indexes and
the `extractCorporateActionTicker` / `extractOfferingAsset` / `extractTransferTo` helpers. They are
a harvester-era carry-over — empty or wrong on the large majority of events, unqueried by either
consumer (`consumer-queries.md`), and duplicating facts the `Claim` (`type` / `scope` /
`filterExpiry` / `issuerId`), corporate-action and STO entities already carry. Removing them also
frees the `Event` index budget the `@subql/node` 10-index cap was pressing against.

**Keep in `compat.sql`**, with a comment on each explaining why the directive cannot express it:
- expression indexes — `left(event_arg_0, 100)` … `event_arg_3`, and `events (module_id, event_id, left(event_arg_2, 100))`
- generated JSONB columns — `attributes`, `params`
- the JSONB path index — `trim('"' from attributes #>> '{2,value,did}')`

**Fix the startup ordering.** `(npm run sql || (sleep 3 && kill "$$")) &` races the node creating tables, while `npm run migrations` runs synchronously before it. Make index/column creation deterministic rather than a race.

**Consider `@fullText`** on `Event.eventArg_0..3` — currently served by `left(col, 100)` expression indexes, which is a prefix match, not a search. **[I]** Measure before switching; a GIN index has a different write cost.

**~~`compat.sql` also owns the `timestamptz` conversion (D8).~~** **D8 was revised to documentation-only (2026-09-10 — see [`../README.md`](../README.md) decision log and [`../architecture-review.md`](../architecture-review.md) §10.1).** The `Date` columns stay `timestamp without time zone`; the timezone ambiguity is addressed by a schema docstring on `Block.datetime` (covering every `Date` field) plus one-liners on the entitlement-critical fields, telling consumers to parse as UTC. No `compat.sql` change, no generator script.

---

## 9.5 Build-time handler check

Closes A3 permanently, ~15 lines:

```ts
// scripts/check-handlers.ts — run in CI and prepack
import * as handlers from '../src/index';
// every handler name in project.ts must exist in handlers
```

Fails the build if `project.ts` names a function that is not exported.

---

## 9.6 `sync-metadata` script

Detail in [`../architecture-review.md`](../architecture-review.md) §3. Scope changes under D5: **migration generation is no longer needed for this redesign** (full resync, no `ALTER TYPE` files). It matters for incremental changes *after* the reset.

What still matters now:
1. Regenerate the three enums in `schema.graphql` deterministically from metadata.
2. Emit stub `project.ts` entries for new events, defaulting to `[]`.
3. **Emit the change report** — new/changed/removed events per spec version. This is the piece that would have caught `TransferWithMemo` at 7.4.0.
4. **Emit an "in enum, registered, not handled" report** — currently ~150 events sit as `[]` with nothing surfacing it.

Reuse `polymesh-types`' `fetchDefinitions.ts` / `diff_versions.ts` rather than rebuilding; its `spec_diffs/` already runs through `8000000-8999999`.

Also delete this repo's stale `spec_diffs/` (stops at 5003000).

---

## 9.7 Entity removals

| Entity | Action |
|---|---|
| `Debug` | Remove — dev instrumentation in the production schema. |
| `FoundType` | Remove, or gate behind a dev flag. Written by `logFoundType` during serialisation. |

Both are unobserved by either consumer **[V]**.

---

## 9.8 Module-level mutable state on the event path (B9)

§9.3 removes `mapChainUpgrade`'s `oldTxVersion`/`oldSpecVersion`. The same pattern exists one layer out, on a far hotter path — [`mappingHandlers.ts:11-13`](../../src/mappings/mappingHandlers.ts#L11):

```ts
let lastBlockHash = '';
let lastEventIdx = -1;
let startupHandled = false;
```

`handleEvent` writes the `Block` row only when the hash changes and calls `handleExtrinsic` only when `extrinsic.idx > lastEventIdx`. Two things follow, and they should be handled separately because only one is a defect.

**The `blocks` table is sparse, and that is worth documenting rather than changing.** `mapBlock` runs from `handleEvent`, not a block handler, so a block producing no handled event gets no row **[V]**. Writing a row for every block would be correct-looking and expensive — under D3 it is an insert per block forever, for rows nothing reads. The right fix is a docstring:

```graphql
"""
A block that produced at least one indexed event. Blocks with no handled event are absent,
so this table is sparse and MAX(blockId) is NOT an indexer-freshness signal — it can sit
behind the chain head while the indexer is current. Use `_metadata.lastProcessedHeight`.
"""
type Block @entity {
```

**The gating itself needs a decision before `--workers` is enabled.** Each worker holds its own copy, so the dedup is per-worker rather than per-index. The `Block` write is idempotent by id and a duplicate is harmless; the `lastEventIdx` gate decides whether an `Extrinsic` row is written at all, which is less obviously safe. **[I]** — not reproduced, and workers are commented out in `docker-compose.yml` **[V]**, so this is latent. Resolve it with A5 rather than separately, and **measure** before replacing the gate with an unconditional write: under historical mode a per-event `Block.save()` is a real cost.

---

## 9.9 What this plan does not cover

Three adjacent plans were split out of this one because they are independently shippable:

- [10](./10-partial-index.md) — partial indexing. Uses `IndexerAnomaly` and `ChainUpgrade` from here.
- [11](./11-throughput.md) — throughput, including one correctness fix (A13, non-total internal paging) that belongs to §9's "make failure visible" theme but needs no infrastructure.
- [12](./12-types-and-ci.md) — chain-type augmentation and the missing `typecheck` gate. Depends on nothing and should land before any of this, because it is what makes the decode layer's types meaningful.

---

## Tests

- **Unit:** `field()` resolves by name; throws `FieldNotFound` on a missing name.
- **Unit:** arity assertion throws and writes an `IndexerAnomaly`.
- **Contract:** for each spec version with checked-in metadata, every registered legacy decoder's declared arity matches the metadata's actual arity. This mechanically detects "the chain changed a shape and we did not notice", with no chain running.
- **Unit:** `ChainUpgrade` is written once per spec transition and is stable across a simulated worker restart.
- **CI:** handler-export check fails on a missing handler.

## Consumer impact

**Near-none.** `IndexerAnomaly` and `ChainUpgrade` are additive; index consolidation is transparent; `Debug`/`FoundType` are unobserved. Existing `Event`/`Extrinsic` **filter** queries are unaffected — those use `moduleId`/`eventId`/`eventArg_0..3`, whose indexes already exist and just move to one place. The seven denormalised `Event` claim/CA/STO columns are **removed** (see §9.4) — neither consumer selects or filters on them per `consumer-queries.md`, but a middleware consumer that read `event.claimType` etc. directly must switch to the `Claim` / corporate-action / STO entities.
