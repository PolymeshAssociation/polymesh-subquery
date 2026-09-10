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
new entity type, no discriminator column. Edit surface (re-counted 2026‑09‑10): **~300
`createdBlockId`/`updatedBlockId` references across ~37 src files plus ~47 across 16 test files**,
plus ~148 `datetime`/`eventIdx`/`extrinsicIdx` write lines — ~500 sites, ~53 files. "~215 type
errors" counts object literals, not properties; budget for the larger number.

> Note on `datetime`: the 17→1 reduction is of the standalone **`datetime`** column, which is
> always a copy of `createdEvent.block.datetime`. The ~13 named domain‑date fields (`expiry`,
> `filedAt`, `start`, `end`, `tradeDate`, `valueDate`, `deletedAt`, `PolyxEntry.date`,
> `IndexerAnomaly.createdAt`) are a different thing and **stay** — verified: every `datetime` write
> site is a block timestamp, no domain date is misfiled as `datetime`.

---

## Decisions resolved for implementation

| Question | Decision | Rationale |
|---|---|---|
| Which entities get a `created_event_id` btree in `db/compat.sql`? | **One: `multi_sig_proposals`.** Switch the three hardcoded portal orderings (`assetTransactions` `CREATED_EVENT_ID_DESC`, `distributionPayments` `CREATED_EVENT_ID_DESC`, `portfolioMovements` `CREATED_BLOCK_ID_DESC`) to `ID_DESC`. | The automatic relation index is GiST and cannot return rows in order **[V]**; `id` gets a plain btree. Where an id is `padId(block)/padId(eventIdx)`, `id` and `createdEventId` are the same value, so ordering by `id` is free. Phase 7.2 zero‑pads `Instruction`/`Venue`/`Proposal`/`Authorization` ids, so those order by `ID_DESC`. That leaves `Claim` (composite, issuer‑scoped — no consumer pages it chronologically **[V]**) and **`MultiSigProposal`** (`multisigAddress/proposalId`, which cannot carry chronological order, and `multiSigProposals` **is** one of the five portal connections — `consumer-queries.md` §1). Add the `MultiSigProposal` btree in 7.6; adding an index during the resync window is free, adding it after is not. |
| `Identity.eventId` / `Account.eventId` | **Drop `Identity.eventId`. Keep `Account.eventId`, flagged.** | `Identity.eventId` is provably constant — every write site passes `DidCreated`, including the genesis mock. `Account.eventId` has three values on a dev chain and overlaps `keyType` + the `identity` relation; drop it only after a mainnet cardinality check. |
| `Leg.addresses` | **Keep for now.** Fix only the unguarded `leg.updatedBlockId = blockId` in `updateLegs` (it fires on the scheduled/unsigned paths where `getSignerAddress` is `undefined`). | `legs` is an SDK‑consumed connection and the design note records connections, not field selections. The append‑only `Leg` + drop‑`addresses` change (N×M write amplification) is real but gated on confirming no consumer selects `addresses`; tracked as a follow‑up. |
| `datetime` timezone | **Docstrings only — no `timestamptz` conversion anywhere.** | The second-revision idea (convert *only* `blocks.datetime`) was wrong: ~13 named `Date` columns survive this rework (`Sto.start`/`end`, `tradeDate`, `valueDate`, four `expiry` fields, `filedAt`, `Portfolio.deletedAt`, `PolyxEntry.date`, `IndexerAnomaly.createdAt`), so converting one leaves exactly the inconsistency the first revision rejected — and `new Date("…+00:00" + "Z")` is `Invalid Date`, breaking 7.1's own docstring. So D8 stands at its **first** revision: all `Date` fields keep the parse-as-UTC docstring, nothing is converted. |
| `PolyxEntry` block filter | **Keep a plain `PolyxEntry.blockId: Int @index` scalar** (not the FK). | `findBlockEntries` (`mapPolyxLedger.ts`, the v8 staking-reward double-count guard) does `getByFields([['createdBlockId','=',blockId],['accountId','=',account]])`. `store.getByFields` supports only `= != in !in` — no range — so "every entry in this block" cannot be expressed via `createdEventId`. This is the design note's own "keep `blockId` when a measured query needs a direct indexed block filter" exception. Document it on the field. |
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

> **Revised 2026‑09‑10 after review.** Nullable‑first (add relations, then populate, then remove
> the old fields) was the original staging. It does not work: SubQuery auto‑indexes every
> entity‑typed field and caps an entity at 10 indexes; `Asset` and `EvmTransaction` are at 10
> today, so a nullable `createdEvent` + `updatedEvent` puts them at 11–12 and the node refuses to
> start. The intermediate state — the whole point of the staging — is the one that fails, and only
> at a boot. Under D5 there is no compatibility to buy with staging anyway. So **7.4 does the
> relation swap atomically** (remove `createdBlock`/`updatedBlock`, add non‑null
> `createdEvent`/`updatedEvent`, fix every handler + test in one commit — net index‑neutral, boots)
> and **7.5 is the lighter follow‑on** (the other derivable fields).

### 7.3 — `feat: 🎸 add Extrinsic.events and a synthetic seed Event` *(additive, done — `15fd13c`)*

- `Extrinsic.events: [Event] @derivedFrom(field: "extrinsic")` — `@derivedFrom` adds no index, so
  this is free even though `Extrinsic` is at 10/10 **[V]**.
- `ModuleIdEnum.seeding` + `EventIdEnum.Seeded`. Enum type names hash the enum *name*, not values,
  so appending is safe; `sync-metadata` only reports `notInRuntime` and never strips **[V]**.
- `genesisHandler` writes one `Event` at `0000000000/0000000000` immediately after the genesis
  `Block`, before any entity insert. Fixes the **genesis half** of A17.
- `seedEventId` is exported. **Follow‑up (7.4):** it is hardcoded to `genesisBlock` — parameterise
  to `startBlock − 1` so plan 10's storage seeding reuses it.

### 7.4 — `feat!: 🎸 record provenance as an Event relation, not a Block+index copy` *(breaking — the atomic swap)*

- Schema: on every event‑backed domain entity, **remove `createdBlockId`/`updatedBlockId`** and
  **add `createdEvent: Event!`** (+ `updatedEvent: Event!` on the mutable set). Net index change is
  zero, so every entity stays under the cap and the node boots.
- `Attributes<T>` in `src/mappings/entities/common.ts`: swap `createdBlockId`/`updatedBlockId` in
  the `Omit` list for `createdEventId`/`updatedEventId`. Helpers typed `Attributes<X>` with no event
  in scope (`getFundraiserDetails` → `Omit<Attributes<Sto>,…>`, `LegDetails`, and the helpers in
  `utils/transferManagers.ts` / `distributions.ts` / `proposals.ts` / `multisigs.ts`) need the omit
  update in this same commit.
- Every creation site sets `createdEventId: blockEventId` (already on `HandlerArgs` from
  `extractArgs`). Every update site sets `updatedEventId` to **the event that changed this row** —
  threaded from the handler's own `SubstrateEvent`, not a blind
  `updatedBlockId = blockId` → `updatedEventId = blockEventId` find‑replace. The rows to watch are
  the ones a handler updates on behalf of a *different* event: `updateLegs`, `mapStatistics` bulk
  paths, `mapCompliance`.
- Thread the `system.CodeUpdated` event through `repairAuthorizationsAfterUpgrade` and
  `handleMultiSigProposalDeleted` (both take only `block` from `onUpgradeCrossed`, which has the
  `SubstrateEvent` in scope). `multiSigProposals` is portal‑consumed, so `MultiSigProposal.updatedEvent`
  must be real, not a stand‑in.
- **A17, live half:** `getOrCreateAccount` (`src/utils/accounts.ts`) calls `createPortfolio` with
  `createdEventId: \`${blockId}/${padId('0')}\`` on *any* block — that resolves to event 0 of a real
  block (usually `timestamp.set`'s `ExtrinsicSuccess`), i.e. wrong provenance, not dangling. Thread
  the real `blockEventId`. Same for `src/seed/holding.ts` and `src/seed/accountBalance.ts` — they
  write `createdBlockId` and must write `createdEventId: seedEventId`.
- **`Event.extrinsicId` bug (fix here):** `src/mappings/entities/common.ts` builds it as
  `event.extrinsic?.idx ? … : undefined` — `idx === 0` is falsy, so `Event` rows for the first
  extrinsic of every block get `extrinsicId = null` while `extrinsicIdx = 0`. `Extrinsic.events`
  (7.3) is therefore empty for extrinsic 0 of every block, and 7.5 removes the `extrinsicIdx`
  fallback. One‑char fix: `!== undefined`.
- `retireChildIdentitiesAtV8` deletes rows — no provenance field, unaffected.
- `updateLegs`: the `leg.updatedEventId` write goes **inside** the `if (address)` guard (A19) so the
  scheduled/unsigned paths stop rewriting every leg with no content change.
- **`PolyxEntry.blockId: Int @index`** — add the plain scalar (see the decisions table);
  `findBlockEntries` filters on it instead of `createdBlockId`.
- Fixture / unit tests updated in the same commit for every handler touched.

### 7.5 — `feat!: 🎸 remove the remaining Block-and-index copies` *(breaking, lighter)*

- Schema: remove standalone `datetime`, `eventIdx`, `extrinsicIdx` from every domain entity; keep on
  the raw `Event` / `Extrinsic` and the `PolyxEntry` id part. Keep `createdBlock` / `updatedBlock`
  on **`EvmAccountMapping` only** (no event on any path).
- Drop `Identity.eventId` (provably constant). Keep `Account.eventId`, flagged for a mainnet check.
- `EvmTransaction`: drop `block` / `createdBlock` / `updatedBlock` / `datetime`; keep `extrinsic`.
- Fix every handler / test still writing a removed field.

### 7.6 — `feat: 🎸 index tuning for the provenance rework` *(compat.sql; not breaking)*

- **A18:** `data_block_datetime_timestamp` is an expression index on
  `((datetime)::timestamp(0) without time zone)` that no generated query can use — PostGraphile
  compares the bare column **[V]**. Replace it with a **plain btree on `datetime`** (the
  block‑range→id‑range time filter after 7.4/7.5 needs it). No `timestamptz` conversion — see the
  decisions table.
- Add `CREATE INDEX … ON multi_sig_proposals (created_event_id)` — the one domain‑keyed
  portal‑consumed connection whose id cannot carry chronological order.
- The three hardcoded portal orderings switch to `ID_DESC` — documented here; the change lands in
  the consumer repos, coordinated.

---

## Time‑range queries after this phase

Removing `createdBlock` changes how "everything in the last six months" is served. Padded ids are
already time‑ordered, so a date range becomes an id range with **no join**:

1. Resolve the range on `blocks` (cheap, and `db/compat.sql` carries the plain btree on `datetime`
   that 7.6 adds — replacing the dead expression index, A18).
2. Filter the entity on its own `createdEventId` (or `id`, where the id is chronological) with that
   id range.

No unix‑timestamp column is added to any entity, and none is added to `Block` — `Date` already
supports range comparison in the generated API. `blocks.datetime` stays `timestamp without time
zone` with a parse‑as‑UTC docstring (D8 first revision); it is not converted.

### `updatedEvent` granularity

Historical mode versions per **block** — the store flushes once per block — so two events updating
the same row in one block collapse into one version whose `updatedEvent` names only the later.
"Which event produced this version" is answerable at block granularity, not per‑event; do not build
an audit view that assumes otherwise.

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
- The seed event: extend `tests/unit/genesisSeedEvent.test.ts` to assert the `Event` is written
  **before** the first entity insert (the current test checks only the row's contents), and add one
  asserting a seeded `Portfolio` points its `createdEvent` at `seedEventId`.
- Integration snapshots (`tests/entities/`) are not in the gate and are already stale on the
  redesign branches; regenerate them at the resync.

## Resync validation

Like Phase 4, this phase needs a genesis resync to validate — the unit gate cannot exercise the
seed‑event FK or the removal of `datetime`/`eventIdx` from live queries. Run the testnet resync
(see the redesign resync notes) and check:

- Every `created_event_id` resolves — no null `createdEvent` on any non‑`EvmAccountMapping` row.
- **No `Portfolio.createdEvent` points at a `system`‑module event** — that would mean a
  `getOrCreateAccount` path still writes `${blockId}/0000000000` instead of the real event
  (A17 live half).
- `indexer_anomalies` stays empty.
- `events` has exactly one `moduleId = seeding` row.
- `Extrinsic.events` is non‑empty for extrinsic 0 of a block that has one (the `Event.extrinsicId`
  `idx === 0` fix).
