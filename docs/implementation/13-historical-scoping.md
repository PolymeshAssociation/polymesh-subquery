# 13 — Historical scoping

What historical mode costs, which of its indexes anything reads, and what the schema does about the ones nothing reads. Historical mode stays on: SubQuery indexes unfinalized blocks only with it, and rewinds a reorg by row version.

**Depends on:** [09](./09-infrastructure.md). Overlaps [11](./11-throughput.md), which measures slow blocks; this measures the standing cost historical mode imposes on *every* block.

**Status:** implemented, in `schema.graphql`, `db/compat.sql` and `db/trimIndexes.ts`.

---

## Measurement basis

Full genesis syncs run to the head of each chain, with `historical: 'height'`, then a measurement of every index with `pg_stat_user_indexes`:

| | Testnet (26.22M blocks) | Mainnet (25.90M blocks) |
|---|---|---|
| Heap / all indexes | 4.5 GB / 10.1 GB | 11 GB / 25.4 GB |
| GiST indexes | 8.48 GB (402) | 21.43 GB (402) |
| GiST read by consumer queries | 2.54 GB | 6.22 GB |
| GiST read only by the indexer | 1.55 GB | 3.99 GB |
| **GiST read by neither** | **4.39 GB (242)** | **11.21 GB (264)** |

The consumer queries are the ones the SDK's and the portal's own query builders generate, run with realistic arguments against a database whose counters had just been reset, and diffed against a five-minute baseline of the indexer alone. Only the indexes those queries touch count as read.

Two things bound the result. The consumer set is those two clients' queries; a third consumer that filters on a field nothing here filters on gets a sequential scan where it had a GiST. And the figures predate the move of an event's references onto `Event.refs`, so the separate reference table in them no longer exists; the list below is built against the current schema.

---

## The constraint that shapes every option

**SubQuery's `--historical` is global, not per-entity.** There is no `@entity(historical: false)` directive and no per-model opt-out. Every `@entity` type gets `_block_range`, and every declared `@index`, every relation and every `@compositeIndexes` entry becomes a composite GiST `(field, _block_range)`. GiST is 86% of the index space and costs far more to maintain on insert than a btree.

So "scope historical to the entities that need it" is **not expressible**. What can be done is to stop building the GiST indexes nothing reads.

---

## 13.1 Most of the database is append-only **[V]**

Classifying by whether a table has *ever* taken an `UPDATE`, most of the data is written once and never changes: `events`, `polyx_entries`, `staking_events`, `extrinsics`, `asset_transactions`, `blocks`, `instruction_events` and `instruction_parties` are the largest. The genuinely mutable entities are few, and `account_balances` and `staking_positions` dominate them.

## 13.2 The cost is **not** row versioning — it is GiST index maintenance **[V]**

Historical mode closes a row (`UPDATE _block_range`) and inserts a new version only *when an existing id is saved again*. An append-only entity never saves the same id twice, so there is nothing to close and no write amplification. What it pays for is the `(column, _block_range)` GiST indexes, maintained on every insert.

At full size the unread ones concentrate in a few tables. On mainnet:

| Table | GiST read by nothing |
|---|---|
| `staking_positions` | 3.1 GB |
| `polyx_entries` | 2.5 GB |
| `account_balances` | 1.6 GB |
| `events` | 1.56 GB |
| `staking_events` | 1.28 GB |

The largest single ones are the relation indexes `account_balances (identity_id)` and `(account_id)`, four `staking_positions` relations (`identity`, `stash`, `controller`, `rewardDestinationAccount`), `polyx_entries (account_id, date)`, and six `events` indexes of about 400 MB each: `extrinsic`, `extrinsicIdx`, `specVersion`, `eventId`, `eventIdx` and `block`.

## 13.3 What reads what

- **The indexer** reads rows by `id`. Every save of a historical entity closes the current row with `WHERE id = $1 AND _block_range @> $2`, which is why `account_balances` and `staking_positions` carry an `(id, _block_range)` GiST (see `db/compat.sql`): for busy ids it took the close-out from 157 ms to 0.8 ms. Everything else it reads goes through `getByFields` / `getAllByFields`, whose fields SubQuery requires to be indexed. Rewind filters on `lower(_block_range)` and `id`, never on one of the dropped indexes.
- **The SDK and the portal** read a small set: `asset_transactions` by identity, portfolio and asset, `polyx_entries` by account and identity, `staking_events` by stash and identity, `events` by module (and by event within a module), `extrinsics` by address, call and hash, `Event.refs` through its GIN, and the small tables (legs, instructions, multisigs, authorizations, claims, holders, agents, portfolios).
- **Everything else** is a GiST maintained on every insert for a query nobody sends.

## 13.4 What was done

1. **Scalar `@index` directives and `@compositeIndexes` entries no handler or consumer uses are removed from `schema.graphql`**, so a fresh database never builds them: 23 scalar fields and five composites, among them `Event.eventIdx`, `.extrinsicIdx`, `.specVersionId`, `.eventId`, `PolyxEntry.movementId`, `.blockId`, and the `(account, date)`, `(account, kind)` and `(kind, date)` composites. The `(account, kind)` one is read only by the `reconcile-polyx` validation script, which can afford the scan.
2. **Relation indexes cannot be removed from the schema** without turning a relation into a plain id and losing its GraphQL navigation, so `db/trimIndexes.ts` drops them, by table size: on the five big tables (`staking_positions`, `account_balances`, `staking_events`, `polyx_entries`, `events`) every relation index goes (17 indexes, 8.57 GB on mainnet); on the small tables only the event and extrinsic stamps go (36 indexes, 111 MB), and the lookups to other entities stay (below). A plain drop would not last: **the node runs `CREATE INDEX IF NOT EXISTS` for every declared index on every start**, because it treats each start as a fresh schema migration, so each restart would rebuild what was dropped. The drop therefore leaves an empty index of the same name (`WHERE false`, which no query can choose); the node finds the name taken and skips it.
3. **Indexes the same pass deliberately keeps**, besides what the indexer and the consumers read: the `unique` ones (`Block.hash`, `Account.address`, `Identity.did`, `Era.eraIndex`, ...), which are lookup keys on large tables; the EVM lookup keys (`ethAddress`, `ethTxHash`, `evmAddress`); and anything scanned at least a thousand times in a full sync. Indexes under 1 MB on both chains are left alone: they cost nothing worth a stand-in. It also keeps the lookups from a small table to another entity (`asset_holders.asset_id`, `identity_keys.identity_id`, `claims.issuer_id`, ...), 27 indexes and 228 MB on mainnet. The measurements that sized the trim came from replaying the SDK's and portal's queries only, and showed zero scans on these because the planner prefers a sequential scan at today's sizes; an explorer joins on them, and the redesign's newer entities (holdings, identity keys, NFTs, instruction parties) were not in the replay. Re-measure them if those tables grow.

The drop matches on table and column list while the index is still a GiST, so it is idempotent and harmless on a database that never had the index, and it runs on every start after `db/compat.sql`. Each index is dropped in a transaction of its own with a short lock timeout, because a drop holds an exclusive lock on its table until it commits and the node is writing to those tables: an index that loses a lock conflict, or fails for any other reason, is logged and left for the next start, and the trim never stops the node. The required DDL in `db/compat.sql` stays one transaction that retries and is fatal on error.

A test (`tests/unit/storeQueryIndexes.test.ts`) fails if a drop takes the index a store query filters on, or one of the measured consumer indexes, or if a drop and the schema disagree about whether the node would recreate it.

## 13.5 Effect

At full size, the entries in `db/trimIndexes.ts` free about 13 GB of GiST on mainnet (8.57 GB from the big tables' relations, 111 MB from small-table stamps, about 4.3 GB from the removed list), against 21.4 GB at the start, and spare every insert their maintenance. Historical queries still work: `_block_range` is still written, and the queries that filter on a dropped column now scan where they used to probe an index.

**Not done:** splitting the append-only entities into a second project with historical off. It would remove the cost entirely, at the price of a second deployment and a second schema, and the trim above takes most of the saving for none of that.

**To re-measure** after consumers' real migrated queries exist: reset `pg_stat_user_indexes`, run them, and compare against `CONSUMER_USED` in the test.
