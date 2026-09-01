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
  claimType: String       @index
  claimScope: String      @index
  claimIssuer: String     @index
}

type Extrinsic @entity @compositeIndexes(fields: [["moduleId", "callId"]]) {
  moduleId: ModuleIdEnum! @index
  callId: CallIdEnum!     @index
  address: String         @index
}
```

**Keep in `compat.sql`**, with a comment on each explaining why the directive cannot express it:
- expression indexes — `left(event_arg_0, 100)` … `event_arg_3`, and `events (module_id, event_id, left(event_arg_2, 100))`
- generated JSONB columns — `attributes`, `params`
- the JSONB path index — `trim('"' from attributes #>> '{2,value,did}')`

**Fix the startup ordering.** `(npm run sql || (sleep 3 && kill "$$")) &` races the node creating tables, while `npm run migrations` runs synchronously before it. Make index/column creation deterministic rather than a race.

**Consider `@fullText`** on `Event.eventArg_0..3` — currently served by `left(col, 100)` expression indexes, which is a prefix match, not a search. **[I]** Measure before switching; a GIN index has a different write cost.

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

## Tests

- **Unit:** `field()` resolves by name; throws `FieldNotFound` on a missing name.
- **Unit:** arity assertion throws and writes an `IndexerAnomaly`.
- **Contract:** for each spec version with checked-in metadata, every registered legacy decoder's declared arity matches the metadata's actual arity. This mechanically detects "the chain changed a shape and we did not notice", with no chain running.
- **Unit:** `ChainUpgrade` is written once per spec transition and is stable across a simulated worker restart.
- **CI:** handler-export check fails on a missing handler.

## Consumer impact

**None.** `IndexerAnomaly` and `ChainUpgrade` are additive; index consolidation is transparent; `Debug`/`FoundType` are unobserved. Existing `Event`/`Extrinsic` queries are unaffected — the indexes already exist, they just move to being declared in one place.
