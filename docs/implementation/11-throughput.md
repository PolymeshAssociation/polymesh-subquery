# 11 — Throughput

Why some blocks take minutes, and what to change. Distinct from the correctness plans: nothing here alters what the index *says*, only what it costs to say it — with one exception (§11.3) that is a genuine correctness defect found while measuring.

**Depends on:** [09](./09-infrastructure.md). Overlaps [03](./03-holdings-nfts.md), which fixes the worst offender structurally.

---

## Problem

Reported symptom: individual blocks take orders of magnitude longer than their neighbours, reproducibly, on both testnet and mainnet. The canonical case is a large NFT mint or burn.

Four cost sources, in descending order of measured impact. Each is stated with what was verified and what is inferred.

---

## 11.1 Unbounded arrays rewritten in full, multiplied by historical mode **[V]**

`NftHolder.nftIds` is `[Int]` — every NFT a holder owns of a collection, in one array on one row.

```ts
// mapNfts.ts:88 — issue
nftHolder.nftIds.push(...ids);
await nftHolder.save();

// mapNfts.ts:95 — redeem
nftHolder.nftIds = nftHolder.nftIds.filter(heldId => !ids.includes(heldId));
await nftHolder.save();
```

Two multipliers compound:

1. **The whole array is rewritten on every mutation.** Removing one id from a 5,000-element array serialises 4,999 unchanged integers.
2. **Historical state tracking is on** — `historical: 'height'` is the default and [D3](../README.md) keeps it deliberately **[V]**. So each `save()` does not update a row; it closes the current `_block_range` and **inserts a new row carrying the entire array**. A holder mutated 100 times across a block leaves 100 row versions, each holding the full array.

The `filter` is also `O(n·m)` — `ids.includes(heldId)` inside a scan of `nftIds`.

### Measured on a real block **[V]**

Testnet block **15,391,572** (2024-09-13), queried against the live middleware:

| | |
|---|---|
| Asset | `0x80df7c05268282eaad949f225609f2dc` |
| Holder | `0x84415cd92b0e…`, default portfolio |
| `RedeemedNFT` rows in the block | **399** |
| `nftIds` carried by each event | **1** |
| That holder's `nftIds` array today | **2,724** |
| Array length at the start of the block | ~3,123 |

**The chain emits one event per NFT, not one per batch.** So 399 events each run a full `filter` over a ~3,000-element array and then `save()` it whole:

```
filter comparisons   Σ ≈ 399 × ~2,920  ≈ 1.16 million
integers serialised  ≈ 1.16 million, across 399 row versions
net effect           399 ids removed
```

Roughly **three thousand integers written per integer deleted**, in one block. That is the mechanism behind "some blocks are extremely slow", and it is arithmetic rather than inference.

With a row-per-`Nft` entity the same block is 399 single-row updates touching one column each.

### Replay fixtures — capture these **[V]**

Both verified against the live testnet middleware:

| Block(s) | What happens | Why it is the right fixture |
|---|---|---|
| **15,391,572** | 399 `RedeemedNFT`, one event each, against a ~3,100-element holder array | Worst case: the array is at its longest and every event rewrites it. Neighbouring blocks do the same |
| **13,528,440 – 13,528,6xx** | **4,990** `IssuedNFT` across ~200 blocks, 20–30 per block | The growth side — each block appends to and rewrites an array that is getting longer |

Pin both in the repo. They convert "this feels slow" into a regression test, and they are the before/after measurement for plan [03](./03-holdings-nfts.md).

**Fix:** plan [03](./03-holdings-nfts.md) already proposes a row-per-NFT `Nft` entity, and the cardinality is verified comfortable — ~6,200 NFTs on mainnet, ~10,700 on testnet **[V]**. That change was justified on *addressability* (an individual token is unqueryable today). It is worth re-stating that it is also the throughput fix: a mint becomes N inserts of a small row instead of one rewrite of a growing array, and a burn becomes N updates instead of an `O(n·m)` scan plus a full-array rewrite.

**There is no cheap mitigation here, and the measurement is why.** `handleNftHoldingsUpdates` already coalesces within an event — but the chain gives it one id per event **[V]**, so there is nothing to coalesce. Batching across a block would need a handler-scoped context object that flushes at the block boundary, which is most of the work of doing it properly and none of the benefit. Do plan [03](./03-holdings-nfts.md).

(One small thing is still worth taking: `getNftHolder` performs a `.get()` and, on a miss, an immediate `.save()` before the caller mutates and saves again — two row versions per new holder where one would do.)

**Generalise the rule:** an array field on an entity is a throughput liability proportional to its length times its mutation count times historical mode. The same shape exists on `InstructionParty.portfolios: [Int]`, `StakingEvent.nominatedValidators: [String!]`, and `IndexOrigin.seededDomains` in plan [10](./10-partial-index.md). Only the first two are hot; `nominatedValidators` is written once per event and never mutated, which is the safe pattern.

---

## 11.2 Chain reads with no negative cache **[V]**

[`getOrCreateAccount`](../../src/utils/accounts.ts#L38):

```ts
let account = await Account.get(address);
if (account) return account;

const rawKeyRecord = (await api.query.identity.keyRecords(address)) as unknown as Codec;
if (rawKeyRecord.isEmpty) {
  return;              // <- nothing written
}
```

An address the chain has no key record for produces **no row and no marker**, so the next event in the same block referencing that address issues the same chain read again, and so does every event after it. A batch touching N unknown addresses costs N reads; a batch touching the same unknown address N times also costs N reads.

This is the single hottest chain-read path in the indexer: `getOrCreateAccount` is reached from `meshAssetHolderToAssetHolder`, which is reached from `rawAssetHolderToAssetHolder`, which runs **twice per asset movement** on v8 (from-holder and to-holder) **[V]**.

**Fix:** an in-memory per-block resolution cache keyed by address, storing negatives as well as positives. Cleared on block boundary — module-level state is already used at this layer, but see §11.4 before adding more of it; the cache belongs on a handler context object, not a module variable.

**Related read paths worth the same treatment**, all `await`ed inside handlers **[V]**:

| Site | Read |
|---|---|
| [`assets.ts:22`](../../src/utils/assets.ts#L22) | `asset.customTypes` |
| [`mapAsset.ts:196`](../../src/mappings/entities/assets/mapAsset.ts#L196) | `asset.assetNames`, `asset.fundingRound` |
| [`mapMultiSigProposal.ts:252`](../../src/mappings/entities/multiSig/mapMultiSigProposal.ts#L252) | `api.queryMulti` — already batched, the correct pattern |
| [`accounts.ts:49`](../../src/utils/accounts.ts#L49) | `identity.keyRecords` |

`queryMulti` in `mapMultiSigProposal` is the template: **one round trip for many keys**. Where a handler issues more than one independent read, it should be a `queryMulti`.

**Rule to adopt:** a chain read inside a handler is a last resort, and it must be justified in a comment at the call site. Everything derivable from an event or from an already-indexed entity is derived, not fetched. The audit found no read that is unavoidable in principle — each is standing in for state the index does not yet hold, which the seeding work in plan [10](./10-partial-index.md) and the holdings work in plan [03](./03-holdings-nfts.md) both reduce.

---

## 11.3 `getPaginatedData` pages over a non-unique order — a correctness defect **[V]**

Found while looking at read cost. [`common.ts:325`](../../src/utils/common.ts#L325):

```ts
const data = await store.getByField<T>(entityName, field, param, {
  limit: 100,
  offset,
  orderBy: field,          // <- the column being filtered on
  orderDirection: 'ASC',
});
```

`orderBy` is the **same column as the filter**, so every row in the result set holds an identical value and the ordering is not a total order. Offset paging over an unstable order can return a row twice and skip another — silently.

The three call sites all read a set they then act on **[V]**:

| Site | Consequence of a repeated/skipped row |
|---|---|
| [`mapSettlement.ts:110`](../../src/mappings/entities/settlements/mapSettlement.ts#L110) — legs of an instruction | a leg's status is not updated on settlement, or updated twice |
| [`mapExternalAgentHistory.ts:36`](../../src/mappings/entities/externalAgents/mapExternalAgentHistory.ts#L36) — group memberships | an agent's membership history misses an entry |
| [`mapStatistics.ts:241`](../../src/mappings/entities/assets/mapStatistics.ts#L241) — transfer compliances | a compliance rule is left stale or double-written |

Whether this has actually fired depends on whether Postgres returns rows in insertion order for these queries in practice. **[I]** — it very likely does today, for small result sets on a freshly written table, which is why nothing has surfaced. It is luck, not a guarantee: the plan changes with table size, `VACUUM`, and parallel scans.

**Fix:** order by `id`, which is unique on every entity, as the sort key — or as a tiebreaker appended to the filter column. This is the same defect class as the padded-id ordering dependency recorded in [D4](../README.md) and `architecture-review.md` §8b: *an ordering that is not total makes offset paging repeat and skip rows.* It is worth stating once as a rule rather than fixing three call sites:

> **Any paged read — internal or consumer-facing — must order by a key that is unique. A filter column is never that key.**

Also worth doing here: `store.getByFields` accepts `{ limit, offset, orderBy, orderDirection }` and is confirmed available **[V]**, so the hand-rolled loop can go. Keep the loop only where the full set is genuinely needed; where the caller wants "the legs of this instruction" the set is bounded by the instruction and a single call with a sufficient limit is correct.

---

## 11.4 Per-block bookkeeping rides on module-level mutable state **[V]**

[`mappingHandlers.ts:11-13`](../../src/mappings/mappingHandlers.ts#L11):

```ts
let lastBlockHash = '';
let lastEventIdx = -1;
let startupHandled = false;
```

`handleEvent` writes the `Block` row only when `blockHash !== lastBlockHash`, and calls `handleExtrinsic` only when `extrinsic.idx > lastEventIdx`. Two consequences, both worth recording:

**A `Block` row exists only for blocks that produced a handled event [V].** `mapBlock` is called from `handleEvent`, not from a block handler. So the `blocks` table is sparse, and `MAX(block_id)` is **not** a freshness signal — it can sit minutes behind the chain head while the indexer is perfectly current. Anything monitoring indexer lag must read `_metadata.lastProcessedHeight`. This should be stated in the schema docstring on `Block`, because it is the kind of thing every new consumer re-derives wrongly.

**It is the same class as A5** (`mapChainUpgrade`'s `oldTxVersion`/`oldSpecVersion`), on a far hotter path. Under `--workers` each thread carries its own copy, so the dedup gating is per-worker rather than per-index. **[I]** — the failure mode has not been reproduced, and it may be benign because the writes are idempotent by id; but the gating on `lastEventIdx` decides *whether an extrinsic is written at all*, which is not obviously safe to get wrong. Workers are currently commented out in `docker-compose.yml` **[V]**, so this is latent.

**Fix:** the `ChainUpgrade` entity in [09](./09-infrastructure.md) removes the `mapChainUpgrade` state. The same treatment applies here — derive "is this the first event of the block" from the event's own position (`event.idx === 0` is not reliable; the block's first *handled* event is what matters) or accept the idempotent write and drop the gate. Measure before choosing: an unconditional `Block.save()` per event is a real write cost under historical mode.

---

## 11.5 Bulk operations are available and mostly unused **[V]**

`store.bulkCreate` / `bulkUpdate` appear only in [`mapSettlement.ts`](../../src/mappings/entities/settlements/mapSettlement.ts#L121) (`Leg`). Every other multi-row write is a loop of individual `save()` calls, each a round trip through the store layer and, under historical mode, its own row version.

Candidates, in order of expected benefit:

| Handler | Current | Bulk form |
|---|---|---|
| NFT mint/burn (after plan [03](./03-holdings-nfts.md)) | N × `Nft.save()` | one `bulkCreate('Nft', …)` |
| `genesisHandler` / `handleSeed` (plan [10](./10-partial-index.md)) | per-entity `save()` in a loop | `bulkCreate` per domain — this is where it matters most, thousands of rows |
| `mapStatistics` compliance sets | loop | `bulkUpdate` |
| `handleToolingEvent` + `handleExtrinsic` per event | individual saves | batching across a block needs a context object first |

---

## Sequencing within this plan

1. **§11.3** first — it is a correctness fix, it is three call sites, and it needs no measurement to justify.
2. **§11.2** negative caching — small, self-contained, and the biggest single win on batch blocks that is available *before* the model changes.
3. **§11.4** `Block` docstring and the freshness note — documentation, minutes.
4. **§11.1** and **§11.5** land with plans [03](./03-holdings-nfts.md) and [10](./10-partial-index.md) rather than separately.

---

## Measurement

None of the above should be taken on faith, and the review has no throughput numbers in it. Before and after each change, capture:

- **Wall time per block**, for the fixtures in §11.1 above and the ten slowest blocks on mainnet.
- **Chain reads per block** — instrument `api.query` behind one wrapper and count. This number should approach zero for ordinary blocks.
- **Row versions written per block** — `SELECT count(*) FROM <table> WHERE _block_range @> N` for the hot tables.

The two testnet fixtures in §11.1 are identified and verified; the equivalent mainnet blocks are not yet. Capturing them is the artifact worth producing first.

---

## Consumer impact

None from §11.1, §11.2, §11.4, §11.5 — internal only.

§11.3 changes no schema and no query surface; it changes which rows internal paging returns, in the direction of correctness.

The `Block` freshness docstring in §11.4 is additive documentation and worth communicating explicitly, since a consumer polling `blocks` for liveness is reading the wrong signal today.
