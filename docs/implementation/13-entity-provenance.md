# 13 — Entity provenance

Folded into **Phase 7** (schema-wide invariants) alongside the datetime docstrings (7.1) and the
padded numeric ids (7.2). This is the largest single schema change in the programme — bigger than
the POLYX ledger — so it is staged across four commits, each of which compiles and is reviewable
on its own.

**Source:** the "Entity provenance and chain location" design note (Francis, 2026‑09‑10). This plan
is that note turned into a build sequence, with the open decisions resolved (below).

---

## The rule

> A domain entity records provenance as a relation to the `Event` (or `Extrinsic`) that caused it,
> and carries no field derivable from that relation.

Concretely:

- Event‑backed append‑only rows: **`createdEvent` only**.
- Event‑backed mutable rows: **`createdEvent` + `updatedEvent`**. `updatedEvent` is the event that
  changed *this row*, not whichever event the handler was processing when it last saved.
- Extrinsic‑backed rows with no useful event: **`createdExtrinsic`** (block reached via
  `createdExtrinsic.block`).
- Genesis / storage‑seeded rows: point at a synthetic **seed `Event`**, so `createdEvent` stays
  non‑null everywhere and no origin‑discriminator column is needed.
- `createdBlock`, `updatedBlock`, standalone `eventIdx` / `extrinsicIdx`, and the `datetime` copy
  come **off** every domain entity. Time lives on `Block`; position lives on `Event` / `Extrinsic`.
- One exception: **`EvmAccountMapping`**, whose pallet emits no event on any path — it keeps a
  `Block` relation and a nullable `Extrinsic`.

## Blast radius (measured on the Phase 6 tree)

| Field | Today | After |
|---|---|---|
| `createdBlock` | 64 entities | 1 (`EvmAccountMapping`) |
| `updatedBlock` | 65 entities | 1 (`EvmAccountMapping`) |
| `createdEvent` | 26 entities | ~60 (every event‑backed domain entity) |
| `updatedEvent` | 0 | ~30 (mutable entities) |
| standalone `datetime` | 17 entities | 1 (`Block`) |
| standalone `eventIdx` | 21 entities | 3 (raw `Event` / `Extrinsic` / `PolyxEntry` id part) |
| standalone `extrinsicIdx` | 5 entities | 1 (raw `Extrinsic`) |

Two synthetic enum values (`seeding` / `Seeded`), one new derived field (`Extrinsic.events`), no
new entity type, no discriminator column. The design note's estimate of **~215 type errors across
~37 handler and test files** is the implementation surface.

---

## Decisions resolved for implementation

| Question | Decision | Rationale |
|---|---|---|
| Which entities get a `created_event_id` btree in `db/compat.sql`? | **None in the first cut.** Switch the three hardcoded portal orderings (`assetTransactions` `CREATED_EVENT_ID_DESC`, `distributionPayments` `CREATED_EVENT_ID_DESC`, `portfolioMovements` `CREATED_BLOCK_ID_DESC`) to `ID_DESC`. | The automatic relation index is GiST and cannot return rows in order **[V]**; `id` gets a plain btree. Where an id is `padId(block)/padId(eventIdx)`, `id` and `createdEventId` are the same value, so ordering by `id` is free and a btree on `created_event_id` would duplicate one that exists. Phase 7.2 also zero‑pads `Instruction` / `Venue` / `Proposal` / `Authorization` ids, so those connections order correctly by `ID_DESC` too. `Claim` and `MultiSigProposal` are the only domain‑keyed candidates left; add a btree for either **only** if a live consumer is shown to page it in time order. |
| `Identity.eventId` / `Account.eventId` | **Drop `Identity.eventId`. Keep `Account.eventId`, flagged.** | `Identity.eventId` is provably constant — every write site passes `DidCreated`, including the genesis mock. `Account.eventId` has three values on a dev chain and overlaps `keyType` + the `identity` relation; drop it only after a mainnet cardinality check. |
| `Leg.addresses` | **Keep for now.** Fix only the unguarded `leg.updatedBlockId = blockId` in `updateLegs` (it fires on the scheduled/unsigned paths where `getSignerAddress` is `undefined`). | `legs` is an SDK‑consumed connection and the design note records connections, not field selections. The append‑only `Leg` + drop‑`addresses` change (N×M write amplification) is real but gated on confirming no consumer selects `addresses`; tracked as a follow‑up. |
| `blocks.datetime` timezone | **Convert to `timestamptz`** in `db/compat.sql`, keep the parse‑as‑UTC docstring. | With `datetime` removed from the 16 domain entities, `Block.datetime` is the *only* timestamp in the schema, so the "inconsistent schema" objection to a partial conversion (§10.1) disappears. `USING datetime AT TIME ZONE 'UTC'` — the containers run `TZ=UTC` so the conversion is lossless. **Verify it survives an indexer restart at the resync** — the SubQuery migration service shows no column‑type reconciliation, but that is inferred, not proven. This supersedes decision D8's schema‑wide conversion; 7.1's docstrings on the surviving domain‑date fields (`tradeDate`, `valueDate`, the `expiry` fields, `filedAt`, `start`/`end`) stay. |
| One seed event, or one per pallet? | **One**, written once in the block before the indexer's start block. Genesis is the same operation (start block 1, seed at block 0). Single `Seeded` value under a `seeding` module. | Matches how the synthetic genesis `Block` already works. |
| Origin discriminator column? | **No.** Read origin from `createdEvent.eventId == Seeded` and `moduleId == seeding`. | A discriminator is a second source of truth beside the relation, unenforceable under historical mode's virtual FKs. |

---

## Target provenance shapes

Six families (design note §"Conceptual schema"):

| Family | Shape | Examples |
|---|---|---|
| Raw chain records | keep unpadded `blockId` / `eventIdx` / `extrinsicIdx`; `Block` is the only record with `datetime` | `Block`, `Event`, `Extrinsic` |
| Event‑backed append‑only | `createdEvent: Event!` only | `AssetTransaction`, `InstructionEvent`, `PolyxEntry`, `Claim`, `Funding`, `DistributionPayment`, `BridgeEvent`, `StakingEvent`, `TickerExternalAgentHistory`, `ConfidentialLegAffirmation`, … |
| Event‑backed mutable | `createdEvent: Event!` + `updatedEvent: Event!` | `Asset`, `Instruction`, `Portfolio`, `Identity`, `Account`, `MultiSig`, `AssetHolder`, `NftHolder`, `Holding`, `AccountBalance`, `Compliance`, `TransferManager`, … |
| Extrinsic‑backed | `extrinsic: Extrinsic!` (drop `block` / `createdBlock` / `updatedBlock` / `datetime`) | `EvmTransaction` |
| Genesis / storage‑seeded | no special fields — `createdEvent` / `updatedEvent` point at the seed event | the seeded subset of `Account` / `Identity` / `Portfolio` / `MultiSig` / `Permissions`‑equivalent |
| Indexer‑owned / diagnostic | keep operational fields as‑is | `IndexerAnomaly`, `Debug`, `FoundType`, `Migration`, `SubqueryVersion` |

**`Mutable` has a concrete test** (design note step 2): a handler fetches the row, assigns a field,
and saves it. Create‑then‑remove and create‑if‑absent are append‑only (the removal's provenance is
the historical `_block_range` close). Applying the test moves `ProposalVote`,
`MultiSigProposalVote`, `TransferComplianceExemption` into *mutable*, and `AgentGroup`,
`AgentGroupMembership`, `AssetMandatoryMediator`, `AssetPreApproval`, `Compliance`,
`ConfidentialAccount`, `InstructionParty`, `TickerExternalAgent` the other way.

---

## Commit sequence

### 7.3 — `feat: 🎸 add Extrinsic.events and a synthetic seed Event` *(additive, non‑breaking)*

- `Extrinsic.events: [Event] @derivedFrom(field: "extrinsic")` — makes the 1‑to‑many navigable
  both ways. Nothing that queries `Event.extrinsic` changes.
- New `ModuleIdEnum.seeding` and `EventIdEnum.Seeded` (next to `unknown` / `Unknown`). They will sit
  in `sync-metadata.ts`'s `notInRuntime` list permanently, as `unknown` already does.
- `genesisHandler.ts` writes one `Event` row at `0000000000/0000000000`
  (`moduleId: seeding`, `eventId: Seeded`, `block: 0000000000`) before any entity insert. This
  **fixes a live [V] defect**: `genesisHandler` already calls `createPortfolio` with
  `createdEventId: '0000000000/0000000000'`, a foreign key that has always pointed at nothing
  (historical mode emits virtual FKs, so Postgres never validated it and `portfolio.createdEvent`
  resolves null against a non‑null field).
- Add `createdEvent` / `updatedEvent` to every event‑backed domain entity as **nullable**, so this
  commit changes no write path and the index stays coherent while 7.4 fills them in.
- `Attributes<T>` in `src/mappings/entities/common.ts` keeps omitting `createdBlockId` /
  `updatedBlockId` for now; add `createdEventId` / `updatedEventId` to the omit list.

### 7.4 — `feat: 🎸 populate createdEvent / updatedEvent from every handler` *(no schema break)*

- Every creation site sets `createdEventId: blockEventId` (already computed by `extractArgs`).
- Every update site sets `updatedEventId` to the event that changed the row — threaded from the
  handler's own `SubstrateEvent`, not defaulted.
- Two upgrade‑time migrations need the event threaded through:
  `repairAuthorizationsAfterUpgrade` and `handleMultiSigProposalDeleted`, both called from
  `onUpgradeCrossed` (a `system.CodeUpdated` handler) — they receive only `block` today.
  **`MultiSigProposal` is portal‑consumed**, so its `updatedEvent` must be real before 7.5 makes
  it non‑null.
- `retireChildIdentitiesAtV8` deletes rows, so it carries no provenance field — unaffected.
- Fixture / unit tests updated in the same commit for every handler touched.

### 7.5 — `feat!: 🎸 record provenance as an Event relation, not a Block+index copy` *(breaking)*

- Schema: remove `createdBlock` / `updatedBlock` / standalone `datetime` / standalone `eventIdx` /
  standalone `extrinsicIdx` from every domain entity. Keep them on `EvmAccountMapping` only.
- Tighten `createdEvent` to `Event!` everywhere and `updatedEvent` to `Event!` on the mutable set.
- Drop `Identity.eventId`.
- `EvmTransaction`: drop `block` / `createdBlock` / `updatedBlock` / `datetime`; keep `extrinsic`.
- Fix every handler and test that still writes a removed field (the bulk of the ~215 errors).
- `updateLegs`: move `leg.updatedBlockId` → `leg.updatedEventId` **inside** the `if (address)` guard
  so the scheduled/unsigned paths stop rewriting every leg with no content change.

### 7.6 — `feat!: 🎸 make blocks.datetime timestamptz and drop the dead expression index` *(breaking, compat.sql)*

- `data_block_datetime_timestamp` is an **expression** index on `((datetime)::timestamp(0) without
  time zone)`; PostGraphile compares the bare column, so no generated query can use it **[V]**.
  Replace with a plain btree on `datetime` — the block‑range→id‑range lookup that serves
  time‑range queries after this phase needs it and does not currently have it.
- `ALTER TABLE blocks ALTER COLUMN datetime TYPE timestamptz USING datetime AT TIME ZONE 'UTC';`
- Switch the three hardcoded portal orderings to `ID_DESC` (documented here; the change lands in
  the consumer repos, coordinated).

---

## Time‑range queries after this phase

Removing `createdBlock` changes how "everything in the last six months" is served. Padded ids are
already time‑ordered, so a date range becomes an id range with **no join**:

1. Resolve the range on `blocks` (cheap, and `db/compat.sql` will carry a plain btree on
   `datetime` after 7.6).
2. Filter the entity on its own `createdEventId` (or `id`, where the id is chronological) with that
   id range.

No unix‑timestamp column is added to any entity, and none is added to `Block` — `Date` already
supports range comparison in the generated API.

---

## Consumer impact

| Removed selectable field | Read it as |
|---|---|
| `datetime` on 16 domain entities | `createdEvent { block { datetime } }` |
| `eventIdx` | `createdEvent { eventIdx }` |
| `extrinsicIdx` | `createdEvent { extrinsic { extrinsicIdx } }` |
| `createdBlock` / `updatedBlock` | `createdEvent { block }` / `updatedEvent { block }` |

**Confirmed break** (`reference/consumer-queries.md` §7): the portal hardcodes
`orderBy: CREATED_BLOCK_ID_DESC` on `portfolioMovements`; `PortfolioMovement.createdBlock` is
removed, so that query stops compiling. Migration is `ID_DESC` — strictly better, and it also
fixes the intra‑block pagination bug `CREATED_BLOCK_ID_DESC` still has.

`datetime` is the widest removal — it is displayed on most list views, so expect it in more
consumer queries than any other field this phase touches. The removal must be coordinated with the
SDK and portal releases, same as 5.7 (`portfolioMovements` fold).

`AssetTransaction.extrinsicIdx` carried a documented signal ("null for scheduled transactions").
After removal that is a two‑hop join; if "scheduled vs user‑submitted" is a real query it deserves
an explicit boolean, not a nullable index restored for the wrong reason. **Open.**

---

## Tests

- Every touched handler gets its fixture / unit test updated in the same commit (7.4 and 7.5).
- Add handler tests asserting the provenance invariant for each creation path — `createdEventId`
  is set and non‑null, no removed field is written.
- The seed event: a `genesisHandler` unit test asserting the `Event` row is written at
  `0000000000/0000000000` before the first entity insert, and that seeded rows point at it.
- Integration snapshots (`tests/entities/`) are not in the gate and are already stale on the
  redesign branches; regenerate them at the resync.

## Resync validation

Like Phase 4, this phase needs a genesis resync to validate — the unit gate cannot exercise the
`timestamptz` conversion, the seed‑event FK, or the removal of `datetime` from live queries. Run
the testnet resync (see the redesign resync notes) and check:

- `blocks.datetime` is `timestamptz` after a node restart (the inferred‑not‑proven item above).
- Every `created_event_id` resolves — no null `createdEvent` on any non‑`EvmAccountMapping` row.
- `indexer_anomalies` stays empty.
- `events` has exactly one `moduleId = seeding` row.
