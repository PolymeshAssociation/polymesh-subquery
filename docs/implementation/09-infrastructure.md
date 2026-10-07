# 09 — Infrastructure

Prerequisite for most other plans. Ships no consumer-visible feature; delivers the decode layer, anomaly recording, upgrade tracking, and index consolidation everything else depends on.

**Entities:** `IndexerAnomaly` (new), `ChainUpgrade` (new), `Event`/`Extrinsic` (index consolidation), `Debug`/`FoundType` (removal). §9.10 *proposes* an argument encoding and an `EventReference` entity, pending a decision.

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
  HandlerError
}
```

Wire into: `toEnum` fallbacks (currently silently `Unknown`), decode failures and `getAsset` misses. The in-flight reconciliation check in [02](./02-polyx-ledger.md) also wrote here as `BalanceReconciliationDrift`, until it was removed.

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

**All three would go if §9.10's proposal is accepted**: it replaces the positional `eventArg_n` columns and the text-plus-generated-JSONB pair with typed `args` and an `EventReference` lookup.

**Fix the startup ordering.** `(npm run sql || (sleep 3 && kill "$$")) &` races the node creating tables, while `npm run migrations` runs synchronously before it. Make index/column creation deterministic rather than a race.

**Consider `@fullText`** on `Event.eventArg_0..3` — currently served by `left(col, 100)` expression indexes, which is a prefix match, not a search. **[I]** Measure before switching; a GIN index has a different write cost. Moot if §9.10's proposal, which removes the columns, is accepted.

**~~`compat.sql` also owns the `timestamptz` conversion (D8).~~** **D8 was revised to documentation-only (2026-09-10 — see [`../README.md`](../README.md) decision log and [`../architecture-review.md`](../architecture-review.md) §10.1).** The `Date` columns stay `timestamp without time zone`; the timezone ambiguity is addressed by a schema docstring on `Block.datetime` (covering every `Date` field) plus one-liners on the entitlement-critical fields, telling consumers to parse as UTC. No column-type change, no generator script. The one `compat.sql` change in this area is separate: Phase 7.6 replaces the dead `data_block_datetime_timestamp` expression index (A18 — an expression index no generated query can use) with a plain btree on `blocks.datetime`, and adds one `created_event_id` btree on `multi_sig_proposals` (D13, plan [13](./13-entity-provenance.md)).

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

## 9.10 Event and call argument encoding — proposed, pending a decision

**Status: a proposal, not a decision, and not built.** It is breaking for both consumers (see *SDK and portal* below and [`../reference/consumer-queries.md`](../reference/consumer-queries.md) §5), so it needs agreement from the SDK and portal maintainers first. It is listed as open question 3 in [`../README.md`](../README.md); if accepted, it becomes a decision there and this status line changes. Until then the current encoding stands.

### Current state

Every `Event` row stores its arguments twice, in a format the indexer defines itself:

- `attributesTxt` — the arguments as JSON, produced by `serializeLikeHarvester`, plus a generated JSONB copy (`attributes`) added by `compat.sql` **[V]**.
- `eventArg_0` … `eventArg_3` — the first four arguments as strings, with `left(col, 100)` expression indexes in `compat.sql` **[V]**.

`Extrinsic` stores its call arguments as `paramsTxt`, which is `JSON.stringify(toHuman().method.args)` — display text, with balances formatted as `"75.8040 mPOLYX"` — plus a generated JSONB copy `params` **[V]**.

The event encoding is the old **harvester**'s, kept for compatibility with an indexer that no longer exists: tuple members keyed `col1`, `col2` …; `Err` spelled `Error`; accounts as hex; moments reformatted as ISO strings with a 6-digit fraction; and a `Balance` passed through `parseInt`, which **loses precision above 2⁵³ base units** **[V]**. It is ~300 lines of our own code, it walks every value's type at runtime, and until it was profiled it described each value 8–10 times over. Speed is not a reason to replace it, though: on a testnet replay of busy blocks, removing it saved about 0.5 ms of an event's ~11 ms **[V]**.

Consumers filter events **positionally**: the SDK's public `Network.getEventByIndexedArgs` / `getEventsByIndexedArgs` take `moduleId`, `eventId` and `eventArg0`–`eventArg2`, exact string match **[V]**. Nothing inside the SDK, the REST API or the portal calls them; they are an escape hatch for third parties **[V]**. Positional filtering is weak in itself: `eventArg0` means something different in each event, the same event can move a field between runtime versions, and only four arguments are reachable.

### Target

**1. One canonical encoding, for event and call arguments alike.** Built on polkadot's own `Codec.toPrimitive()`, with a short, documented normalisation on top, rather than a serialiser of our own:

| Value | Encoded as |
|---|---|
| any integer (`u8`…`u128`, `Compact`, `Balance`, `Moment`) | decimal **string**, never a JSON number — no precision loss, and one type to compare |
| `AccountId` | SS58 address, with the chain's prefix |
| `IdentityId`, `AssetId`, hashes, fixed byte arrays | `0x` hex |
| `Ticker` | text, trailing nulls removed |
| `Bytes`, `Text` | UTF-8 text when valid, else `0x` hex |
| struct | object keyed by the metadata's field names |
| tuple | array |
| enum | `{ "<variant>": value }`, or the variant name for a unit variant |
| `Option` | the value, or `null` |
| `Result` | `{ "ok": value }` / `{ "err": value }` |

The exact casing `toPrimitive()` gives enum variants and struct fields is to be pinned down when building it, and fixed by tests, since it then becomes the contract **[I]**.

**2. Schema.**

```graphql
type Event @entity {
  # …
  "The event's arguments, canonically encoded (plan 09 §9.10), keyed by field name where the metadata names them"
  args: JSON!            # jsonField: filterable with `contains`
  references: [EventReference!]! @derivedFrom(field: "event")
}

"Something an event refers to: an identity, account, asset or portfolio in any of its arguments"
type EventReference @entity
  @compositeIndexes(fields: [["kind", "value"], ["event", "kind"]]) {
  id: ID!                # `${eventId}/${n}`, padded (D4)
  event: Event!
  kind: EventReferenceKind!   # Identity | Account | Asset | Portfolio
  value: String!         # canonical encoding of the referenced value
  argument: String       # the field it was found in, where named
}

type Extrinsic @entity {
  # …
  args: JSON!            # the call's arguments, the same encoding
}
```

`args` is shaped as an object keyed by field name when the metadata names every field (every v8 event, and the struct-style events before it), and as an array otherwise (Polymesh's tuple-style events before v8).

**Removed:** `Event.attributesTxt`, `Event.eventArg_0` … `eventArg_3`, `Extrinsic.paramsTxt`, and from `compat.sql` the generated `attributes` / `params` columns, the four `left(event_arg_n, 100)` indexes, the `(module_id, event_id, left(event_arg_2, 100))` index and the `attributes #>> '{2,value,did}'` path index.

**3. References are found generically, by metadata type name**, with no code per event: while encoding, any value whose type is `IdentityId`, `AccountId`, `AssetId` / `Ticker` or `PortfolioId` adds an `EventReference` (a `PortfolioId` also adds its identity). A pre-v7 `Ticker` is recorded under the asset id it maps to (`getAssetIdForLegacyTicker`), so one query finds an asset's events across the ticker-to-id migration.

**4. Implementation notes.**

- `serializeLikeHarvester.ts` is deleted, not renamed.
- `mapClaim` currently reads its claim fields out of the serialiser's output (`extractHarvesterArgs`); it moves to `decodeEvent`, like every other handler.
- Write cost: the `eventArg_n` expression indexes go and `EventReference` rows come in, about 1–3 per event **[I]**. Measure on a testnet resync against the current run's throughput before settling; the fallback is reference arrays on `Event` with one GIN index in `compat.sql`.

### SDK and portal

| Today | Becomes |
|---|---|
| `getEventByIndexedArgs({ moduleId, eventId, eventArg0..2 })` / `getEventsByIndexedArgs(...)` | `getEvents({ moduleId?, eventId?, involving?: { identity? \| account? \| asset? \| portfolio? }, args?: object, size?, start? })` |
| `eventArg0: '<hex account>'` | `involving: { account: '<SS58 address>' }` — an `EventReference` filter, at any argument position |
| a value that is not a reference (an amount, a flag) | `args: { … }` — a JSONB `contains` filter on `Event.args` |
| `Extrinsic.paramsTxt` / `params` (`toHuman` text) | `Extrinsic.args`, canonical encoding — balances become integer strings, not formatted text |

The GraphQL for `involving` is `events(filter: { moduleId, eventId, references: { some: { kind: { equalTo: Identity }, value: { equalTo: $did } } } })`. The portal's multisig table parses `createdEvent.extrinsic.params` (`MultiSigTable/hooks.tsx`), and the SDK selects `paramsTxt` (`middleware/queries/extrinsics.ts`) and `params` (`middleware/queries/multisigs.ts`); all three move to `args` **[V]**.

### Tests

- **Contract:** the encoding of a fixture of real events and calls from each runtime era (v3 to v8) is checked in, so any change to the public format fails a test.
- **Unit:** an event naming an identity, an account and a portfolio writes three references and a fourth for the portfolio's identity; a pre-v7 ticker is referenced under its asset id.
- **Unit:** integers above 2⁵³ round-trip exactly.

---

## Tests

- **Unit:** `field()` resolves by name; throws `FieldNotFound` on a missing name.
- **Unit:** arity assertion throws and writes an `IndexerAnomaly`.
- **Contract:** for each spec version with checked-in metadata, every registered legacy decoder's declared arity matches the metadata's actual arity. This mechanically detects "the chain changed a shape and we did not notice", with no chain running.
- **Unit:** `ChainUpgrade` is written once per spec transition and is stable across a simulated worker restart.
- **CI:** handler-export check fails on a missing handler.

## Consumer impact

**Near-none.** `IndexerAnomaly` and `ChainUpgrade` are additive; index consolidation is transparent; `Debug`/`FoundType` are unobserved. Existing `Event`/`Extrinsic` **filter** queries are unaffected — those use `moduleId`/`eventId`/`eventArg_0..3`, whose indexes already exist and just move to one place. **§9.10's proposal, if accepted, is breaking**: `eventArg_0..3`, `attributesTxt` and `Extrinsic.paramsTxt` / `params` would be replaced by `args` and `EventReference`, changing the SDK's `getEventByIndexedArgs` / `getEventsByIndexedArgs` and the extrinsic params the SDK and portal parse — see §9.10's *SDK and portal* table. The seven denormalised `Event` claim/CA/STO columns are **removed** (see §9.4) — neither consumer selects or filters on them per `consumer-queries.md`, but a middleware consumer that read `event.claimType` etc. directly must switch to the `Claim` / corporate-action / STO entities.
