# 10 — Starting an index at any block

An index can start at any block, genesis included, and holds the same rows from there as an index
that ran from genesis, except for the fields only history can give. There is one start path.
Genesis is its case where the start block is block 1.

**Entities:** `IndexOrigin` (operational).

**Code:** `src/seed/` (start, snapshot, shapes, seeders), `scripts/verify-seed.ts`.

---

## The start

`START_BLOCK` picks the first block. Its block handler (`handleGenesis` for block 1, `handleSeed`
otherwise) calls `startIndex` (`src/seed/start.ts`), which:

1. refuses the first block after a runtime upgrade, whose parent state the previous runtime wrote
   (start at the next block instead);
2. writes the start block (the genesis block for block 1) and the `Seeded` event every seeded
   row's `createdEvent` points at;
3. runs every seeder over the state the start block began from;
4. writes `IndexOrigin`.

The block's own events are then handled as any block's. The node commits the block whole or not
at all, and the seeders only upsert, so a seed that fails part-way and is retried ends as a clean
start does.

## Seeders

A seeder (`src/seed/seeder.ts`) builds one entity's rows from a `ChainSnapshot` and nothing else:
no store reads, no RPC, so its rows don't depend on which seeders ran before it. All of them are
listed in `src/seed/seeders/index.ts`.

| Field | Meaning |
|---|---|
| `entity`, `rows(snap, ctx)` | the rows, a page at a time |
| `reads` | the storage items it reads. The snapshot refuses an item no seeder declares |
| `oldShapes` | for an item read before 6.0, the survey ranges whose shape it handles |
| `relative` | fields whose value depends on history before the start: totals counted from it, and facts the chain doesn't keep (who created a row, who affirmed) |
| `accounts` | fields naming an `Account`, for the account closure |
| `terminal` | a finished row the chain prunes, which an index keeps and a seed can't write |
| `parent` | the row this one belongs to, pruned with it once that is finished |
| `key` | a natural key, for an interval whose id names the event that opened it |
| `raw` | items whose values it reads from their raw bytes when the types can't decode them |

The snapshot (`src/seed/snapshot.ts`) reads storage in bulk at the parent hash: pages of 1,000
keys, one `queryStorageAt` per page, a few requests in flight, and a page halved when its
response is too big. It checks every item's shape (keys, value, hashers) against
`src/seed/knownShapes.json`, which `yarn seed:shapes` generates from the storage survey. A shape
no seeder was written for stops the seed rather than misreading it. A value the block's types
can't read (or read only part of) stops the seed too, unless the seeder declares it reads that
item's raw bytes (`raw`): skipping it would leave a row out.

After the seeders, every address a seeded row names that no seeded `Account` covers gets one.

## What a seeded row can't know

`IndexOrigin.relativeFields` lists every `Entity.field` a seeder declares `relative`. On a row
seeded at the start those fields are empty or count from zero. Consumers comparing two indexes, or
reading a lifetime total, read it there. A few fields are nullable for the same reason:
`AssetMandatoryMediator.addedBy`, a committee PIP's `Proposal.owner`, and
`ConfidentialSettlement.assetRootBlock`.

## Upgrades

A runtime upgrade's migration runs as the first block of the new code begins and emits nothing.
The handlers apply each one by rule as the chain crosses into its runtime (`onUpgradeCrossed` in
`src/mappings/entities/block/mapChainUpgrade.ts`, the rules in `src/mappings/migrations/`), with no
chain read, so an index started before an upgrade holds what one started after it would.
`verify-seed` at U+2, where U is the block carrying `system.CodeUpdated`, proves its rule. The rule
runs at U and the migration as U+1 begins, so a seed at U+1 reads U's pre-migration state against
an index that has already applied the rule; at U+2 both sides are past the migration. It is also
the first block after U that `startIndex` accepts.

## Proving it

`yarn verify-seed --endpoint <ws> --gql <url> --height <h>` seeds at `h` into memory, reads every
seeded entity from an index's GraphQL as of `h - 1` (historical queries), and reports per entity
the rows only one side holds and the fields they disagree on. It matches intervals by `key`, skips
provenance and `relative` fields, and allows `terminal` rows and their children. An index that
equals its own seed at a height is one a start there would have produced. Run it after any change
to a handler or a seeder.

## Extending it

- **A new entity:** a seeder in `src/seed/seeders/`, listed in `index.ts`. `seeders.test.ts`
  fails until its reads are surveyed, `knownShapes.json` is regenerated, and every `Account`
  relation is listed in `accounts`.
- **New or changed storage:** run the storage survey and `yarn seed:shapes`. A changed shape fails
  the seed until a seeder handles it.
- **An upgrade whose migration rewrites storage:** a rule in `src/mappings/migrations/`, called from
  `onUpgradeCrossed`, then `verify-seed` at U+2 (see Upgrades).
- **A field history alone can give:** add it to the seeder's `relative`.
