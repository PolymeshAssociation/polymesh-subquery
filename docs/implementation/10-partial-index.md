# 10 — Partial index (arbitrary start block)

Makes `START_BLOCK > 1` a **supported deployment mode** rather than a broken flag: the indexer seeds entity state from chain storage at the start block, and every handler write is safe against an entity it has never seen.

**Entities:** no new consumer-facing entities. One operational entity (`IndexOrigin`) and a new `src/seed/` module.

**Depends on:** [09](./09-infrastructure.md) (`IndexerAnomaly`, `ChainUpgrade`).

---

## Problem

`START_BLOCK` exists in [`project.ts:8`](../../project.ts#L8) and does not work. Two independent failures:

### 1. The genesis datasource leaves an uncoverable gap **[V]**

```ts
dataSources: [
  { kind: Runtime, startBlock: 1, endBlock: 1, handlers: [handleGenesis] },
  { kind: Runtime, startBlock, ... },
]
```

With `startBlock = 24_928_521` the manifest declares two disjoint ranges — `[1,1]` and `[24928521,∞)` — and the node will not begin at block 1 and then jump. `handleGenesis` is also **not idempotent**: it unconditionally creates the genesis `Block`, so it cannot simply be widened.

The fix is one conditional, and it already exists as a local patch that has been used in anger to start a testnet index at block 24,928,521:

```ts
dataSources: [
  // handleGenesis is not idempotent (it unconditionally creates the genesis Block entity), so it
  // can only ever run once at block 1. Skip it entirely when starting from a later block,
  // otherwise this dataSource leaves an uncovered gap between block 1 and `startBlock` that the
  // indexer refuses to cross.
  ...(startBlock <= 1
    ? [
        {
          kind: SubstrateDatasourceKind.Runtime,
          startBlock: 1,
          endBlock: 1,
          mapping: {
            file: './dist/index.js',
            handlers: [{ kind: SubstrateHandlerKind.Block, handler: 'handleGenesis' }],
          },
        },
      ]
    : []),
  { kind: SubstrateDatasourceKind.Runtime, startBlock, ... },
]
```

**Take this patch as-is.** It is small, it is proven, and it is independent of everything else in this plan — it should land on its own rather than waiting for the seeding work, because it is what unblocks day-to-day development against a recent block.

That gets the indexer *running*. It does not make its output correct, which is the second failure.

### 2. State is initialised empty, so the first mutation stalls **[V]**

Handlers across the codebase assume the entity they are about to modify exists, because on a genesis replay it always does. Representative:

| Site | Assumption |
|---|---|
| [`mapNfts.ts:44`](../../src/mappings/entities/assets/mapNfts.ts#L44) `handleNftCollectionCreated` | `getAsset(assetId)` resolves |
| [`mapNfts.ts:78`](../../src/mappings/entities/assets/mapNfts.ts#L78) | `asset.totalSupply += …` — starts at `0`, so supply becomes a delta |
| [`mapSettlement.ts:110`](../../src/mappings/entities/settlements/mapSettlement.ts#L110) | `getPaginatedData('Leg', 'instructionId', …)` returns the instruction's legs |
| [`mapExternalAgentHistory.ts:36`](../../src/mappings/entities/externalAgents/mapExternalAgentHistory.ts#L36) | the `AgentGroupMembership` rows exist |
| [`mapStatistics.ts:241`](../../src/mappings/entities/assets/mapStatistics.ts#L241) | the existing `TransferCompliance` set is complete |

Starting at an arbitrary block breaks all of them at once, in two different ways:

- **Hard stall** — `getAsset` (and friends) throw on a missing row, the promise rejects, and the block is retried forever.
- **Silent wrongness** — `asset.totalSupply += BigInt(ids.length)` on a freshly created `Asset` produces a supply that is the *net change since the start block*, presented as a total. This is the worse of the two, because nothing surfaces it.

The second class is why "just make every write an upsert" is not on its own a solution. An upsert removes the stall and keeps the wrong number.

**One handler already does the right thing, and is the template.** [`getOrCreateAccount`](../../src/utils/accounts.ts#L38) reads `identity.keyRecords` from chain storage when the `Account` row is absent and constructs it from what the chain says. Generalising that pattern is this plan.

---

## Design

Three parts, in dependency order.

### 10.1 `IndexOrigin` — record what kind of index this is

```graphql
"""
Records the block this index was seeded from, and how. Absent on a genesis replay.

Any consumer computing a total from this index must check this entity first: values
derived by accumulation (supply, holder counts, balances) are only absolute if the
index starts at genesis or the domain was seeded.
"""
type IndexOrigin @entity {
  id: ID!
  "The first block this index processed"
  startBlock: Int!
  "Hash of that block, so a reseed against a forked chain is detectable"
  startBlockHash: String!
  "Spec version at the start block"
  specVersion: Int!
  "Domains successfully seeded from chain storage at startBlock"
  seededDomains: [String!]!
  "Domains that could not be seeded, with the reason"
  unseededDomains: [String!]!
  datetime: Date!
  createdBlock: Block!
}
```

One row, written by the seeding handler. A genesis replay writes `startBlock: 1` with every domain listed as seeded — which is true, since a genesis replay derives everything.

This entity is the honesty mechanism. Without it a partial index is indistinguishable from a complete one at the GraphQL surface, and every accumulated number is a trap.

### 10.2 Seeding from chain storage at the start block

A block handler bound to `[startBlock, startBlock]`, mirroring the existing genesis datasource:

```ts
dataSources: [
  ...(startBlock <= 1
    ? [{ kind: Runtime, startBlock: 1, endBlock: 1, handlers: [handleGenesis] }]
    : [{ kind: Runtime, startBlock, endBlock: startBlock, handlers: [handleSeed] }]),
  { kind: Runtime, startBlock, ... },
]
```

**This works because `api.query` inside a handler targets the block being indexed [V].** `getPatchedApi` builds `api.at(currentBlockHash)` and injects the block hash into historic RPC params, so a handler running at the start block reads storage *as of that block* with no `.at` call of its own — which is fortunate, since `.at`/`.entriesAt`/`.keysAt`/`.range` are unsupported inside handlers **[V]** (`architecture-review.md` §8b). The seeding handler is the one place in the design where that is exactly the semantics wanted.

**Seed order matters** — later domains reference earlier ones:

| # | Domain | Chain storage | Notes |
|---|---|---|---|
| 1 | Identities & keys | `identity.didRecords`, `identity.keyRecords` | `.entries()` — the largest scan |
| 2 | Accounts | derived from 1, plus `revive.originalAccount` | reuses `getAccountKeyType` |
| 3 | Permissions | `identity.keyAssetPermissions`, `keyPortfolioPermissions`, `keyExtrinsicPermissions` | |
| 4 | MultiSigs | `multiSig.adminDid`, `multiSigSigners`, `multiSigSignsRequired` | `genesisHandler` already does this |
| 5 | Portfolios | `portfolio.portfolios`, `portfolio.portfolioCustodian` | |
| 6 | Assets | `asset.assets`, `assetNames`, `fundingRound`, `nft.collectionAsset` | supplies `totalSupply`, the number §10.3 protects |
| 7 | Holdings | `asset.balanceOf` / v8 account-level layer, `portfolio.portfolioAssetBalances`, `nft.numberedPortfolio` | the big one — see plan [03](./03-holdings-nfts.md) |
| 8 | POLYX balances | `system.account` | seeds `AccountBalance` — see plan [02](./02-polyx-ledger.md) |
| 9 | Settlement in flight | `settlement.instructionDetails`, `instructionLegs`, `venueInfo` | only *pending* instructions matter |
| 10 | Compliance & statistics | `complianceManager.assetCompliances`, `statistics.activeAssetStats` | |

`genesisHandler` already implements the shape for domains 1–4 and 8 (accounts, identities, portfolios, multisigs, permissions, EVM mappings) **[V]**. **Refactor rather than duplicate**: extract the per-domain seeders into `src/seed/`, and let `handleGenesis` and `handleSeed` both call them. That also removes the current `genesisHandler` limitation noted in `README.md` — it creates accounts and identities but **no balances**, which plan [02](./02-polyx-ledger.md) needs fixed regardless of this plan.

**Cost.** Domains 1, 2 and 7 are full-map `.entries()` scans. On mainnet that is tens of thousands of keys for identities and materially more for holdings — minutes, once, at start. Acceptable for a one-off; it must be **paged** (`entriesPaged`) rather than a single `.entries()` on the large maps, or the node will hold the whole map in memory. Not every domain need be seeded: `seededDomains` exists so an operator can seed the three that matter to them and have the index say so.

### 10.3 Accumulation is only valid over a seeded domain

Two rules, enforced in code rather than by convention:

**Rule 1 — no bare `+=` on a value that represents a total.** Every accumulating field gets a helper that refuses to run against an unseeded domain:

```ts
// throws + writes an IndexerAnomaly if `assets` is not in IndexOrigin.seededDomains
accumulate(asset, 'totalSupply', BigInt(ids.length), 'assets');
```

The alternative — letting it accumulate from zero — is the silent-wrongness case, which the whole review is against (§8 principle 2: *unknown is recorded, never guessed*).

**Rule 2 — a missing entity is created from chain state, or recorded.** Generalise `getOrCreateAccount` into one path:

```ts
// resolve from DB; on miss, read the chain at the current block; on a second miss,
// write an IndexerAnomaly and return undefined. Never a bare throw, never a zero-filled row.
const asset = await resolveAsset(assetId, ctx);
```

This is worth doing **independently of partial indexing**. It closes the same class of failure on a full resync when a handler reaches an entity a coverage gap left unwritten — which is how several defect-log entries present.

---

## Handler changes

| Change | Sites | Note |
|---|---|---|
| `getAsset` → `resolveAsset` | [`common.ts`](../../src/mappings/entities/common.ts) + callers | chain fallback |
| `getNftHolder` → chain fallback on miss | [`mapNfts.ts:18`](../../src/mappings/entities/assets/mapNfts.ts#L18) | currently creates an empty holder unconditionally |
| `asset.totalSupply +=` / `-=` | [`mapNfts.ts`](../../src/mappings/entities/assets/mapNfts.ts), [`mapAsset.ts`](../../src/mappings/entities/assets/mapAsset.ts) | `accumulate()` |
| `asset.totalTransfers +=` | as above | `accumulate()` |
| `getPaginatedData('Leg', …)` | [`mapSettlement.ts:110`](../../src/mappings/entities/settlements/mapSettlement.ts#L110) | empty result on a partial index is legitimate — record, do not throw |
| `getOrCreateAccount` | [`accounts.ts:38`](../../src/utils/accounts.ts#L38) | already correct; add negative caching (plan [11](./11-throughput.md)) |

---

## project.ts

```ts
const startBlock = Number(process.env.START_BLOCK) || 1;
```

Add the conditional genesis/seed datasource described in §10.2. No handler filter changes.

---

## Tests

1. **Unit** — `accumulate()` throws and records an anomaly for an unseeded domain; passes through for a seeded one.
2. **Unit** — `resolveAsset` returns the DB row, then the chain-derived row, then `undefined` + anomaly.
3. **Unit** — `project.ts` emits one datasource when `startBlock > 1` and two when it is `1`. Cheap, and it pins the defect that motivated this plan.
4. **Integration** — start against a local chain at block N > 1; assert `IndexOrigin` exists, that a subsequent transfer of a pre-existing asset does not stall, and that `Asset.totalSupply` matches chain storage rather than the delta.

---

## Consumer impact

Additive. `IndexOrigin` is a new entity; nothing existing changes shape.

The **semantic** impact is real and should be stated to consumers explicitly: against a partial index, any accumulated total is only meaningful if its domain is in `IndexOrigin.seededDomains`. A consumer that never queries a partial index is unaffected. Publishing this entity is what lets one that does tell the difference.
