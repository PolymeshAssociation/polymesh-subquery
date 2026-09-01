# Implementation Plans

Per-domain plans for the redesign. Each plan states current state, target schema, handler changes, `project.ts` changes, backfill, tests, and consumer impact.

Read [`../README.md`](../README.md) first for the decision log; these plans assume D1–D5.

Event shapes for every domain below are verified in [`../reference/event-shape-verification.md`](../reference/event-shape-verification.md) — consult it before writing any decoder.

## Plans

| # | Plan | Scope | Depends on |
|---|---|---|---|
| [00](./00-quick-fixes.md) | Defect fixes | A1–A12 that stand alone | — |
| [01](./01-claims.md) | Claims | `Claim` id collision, `ClaimScope` | 00 |
| [02](./02-polyx-ledger.md) | POLYX ledger | `PolyxEntry`, `AccountBalance`; retires `PolyxTransaction` | 00, 09 |
| [03](./03-holdings-nfts.md) | Holdings & NFTs | `Holding`, `Nft`, `AssetAllowance`, `AssetMetadata` | 09 |
| [04](./04-identity-keys.md) | Identity & keys | `IdentityKey`; retires `AccountHistory` | 09 |
| [05](./05-movement-ledger.md) | Movement ledger | `PortfolioMovement` → `AssetTransaction` | 03 |
| [06](./06-corporate-actions.md) | Corporate actions | `CorporateAction`, `Checkpoint`, `CorporateBallot` | — *(low priority, D6)* |
| [07](./07-staking.md) | Staking | `StakingPosition`, `Nomination`, era tracking | 02 |
| [08](./08-external-agents.md) | External agents | Merge the three `TickerExternalAgent*` entities | — |
| [09](./09-infrastructure.md) | Infrastructure | `IndexerAnomaly`, `ChainUpgrade`, decode layer, index consolidation | — |

**06 is in scope but low priority (D6)** — purely additive, dependency-free in both directions, so it can land in parallel whenever capacity allows.

**09 is a prerequisite for most others** — it delivers the decode layer, anomaly recording, and the `ChainUpgrade` hook the others build on. Do it early even though it ships no consumer-visible feature.

---

## Shared conventions

These apply to every plan; they are not repeated in each.

### Full resync, no migrations (D5)

`db/migrations/*` is **deleted**. The redesign ships as a clean `schema.graphql`; the database is rebuilt from genesis. Consequences:

- **No `ALTER TYPE … ADD VALUE` files** for any of this work. Enum values come from the schema.
- No additive → deprecate → remove staging. Entities are replaced outright.
- No backfill scripts — the resync *is* the backfill.
- `db/schemaMigrations.ts` and the runner stay, for incremental changes *after* the reset.
- `db/compat.sql` stays, reduced to what schema directives cannot express (see [09](./09-infrastructure.md)).

### Entity id scheme (D4)

Every entity that consumers paginate **must** carry a zero-padded, block-then-index composite id:

```
`${padId(blockId)}/${padId(eventIdx)}`          // one row per event
`${padId(blockId)}/${padId(eventIdx)}/${side}`  // multiple rows per event
```

Ordering by `id` must be equivalent to chronological order, *including within a block*. This is a hard consumer dependency — the SDK orders `polyxTransactions` by `IdDesc` precisely because `createdBlockId` alone makes pages repeat or skip rows. Where one event yields several rows, the sub-index must be deterministic and stable across replays.

### Schema directive constraints (§8b)

- `@index` is **not** valid on `Boolean` or JSON fields — use a nullable relation and filter `isNull: true`.
- `@compositeIndexes` caps at **3 columns**, excluding Boolean/JSON.
- Declare indexes in `schema.graphql`, not `compat.sql`, unless the directive cannot express them.

### Handler conventions

- Handlers consume decoded DTOs; no `params[i]` access in a handler body (see [09](./09-infrastructure.md)).
- Every positional decode asserts arity.
- Decode failure, unknown enum, or missing referenced entity writes an `IndexerAnomaly` row — never a silently wrong value.
- Register every event in `project.ts`. An event with no handler is `[]` **and** appears in the sync-metadata report.

### Definition of done

A plan is complete when:
1. Schema changes are in `schema.graphql` and `yarn codegen` regenerates cleanly.
2. Handlers are updated and every touched event has a fixture-based unit test.
3. A metadata-contract test asserts declared arity against real metadata for each supported spec range.
4. Affected SDK/portal queries are enumerated with the change each needs.
5. A full resync completes and the reconciliation/anomaly counts for the domain are zero (or explained).

### Consumer coordination

The blast radius is bounded and enumerable: `polymesh-sdk` `origin/develop` (27 connections) and `polymesh-portal` `origin/main` (5). Each plan lists which of those it breaks. Nothing ships to a shared endpoint until the corresponding consumer change is ready.
