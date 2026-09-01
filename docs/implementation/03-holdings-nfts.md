# 03 — Holdings & NFTs

Moves asset holdings to the finest grain the chain uses, makes individual NFTs addressable, and indexes the v8 account-level asset layer.

**Entities:** `Holding` (new), `Nft` (new), `AssetAllowance` (new), `AssetMetadata` (new), `AssetHolder`/`NftHolder` (become rollups or removed), `Asset` (fields).

**Depends on:** [09](./09-infrastructure.md).

---

## Problem

- **G8 — no portfolio-level holding entity exists at all** **[V]**. `AssetHolder`/`NftHolder` are keyed `assetId/did`. "What does portfolio `did/1` hold?" requires replaying every movement. The portal already filters `fromPortfolioId`/`toPortfolioId` **[V]**, so this is a live requirement.
- **G9 — no per-NFT entity.** NFTs are integers inside `NftHolder.nftIds: [Int]`. "Who owns NFT #42?" means scanning rows and searching arrays; provenance is unanswerable.
- **G10 — `nftIds` typed `[Int]` here, `[BigInt]` on two other entities.**
- **G11 — the v8 account-level layer is unindexed** **[V]**: `Approval`, `AllowanceSpent` absent from `project.ts`; `CreatedAssetTransfer` registered `[]`. These are `AccountId32`-keyed, bypassing the identity/portfolio model entirely.
- **G13 — asset metadata entirely unindexed** (ten events `[]`, no entity).

---

## Target schema

```graphql
"""
One row per (asset, holder) at the FINEST grain the chain uses.
Identity-level holdings are derived from these, never stored as primary truth.
"""
type Holding @entity @compositeIndexes(fields: [["assetId", "identityId"], ["portfolioId", "assetId"]]) {
  id: ID!                        # assetId/portfolioId  or  assetId/address
  asset: Asset! @index

  holderKind: HolderKind!
  portfolio: Portfolio @index    # set when holderKind = Portfolio
  account: Account @index        # set when holderKind = Account (v8)
  "denormalised — makes identity rollup a groupBy, not a join"
  identity: Identity @index

  amount: BigInt!                # fungible
  nftCount: Int!                 # non-fungible; ids live on Nft
  updatedBlock: Block!
}

enum HolderKind { Portfolio, Account }

type Nft @entity @compositeIndexes(fields: [["assetId", "nftId"]]) {
  id: ID!                        # assetId/padId(nftId)
  asset: Asset! @index           # the collection
  nftId: BigInt!                 # BigInt everywhere — resolves G10

  "current location; exactly one is set"
  portfolio: Portfolio @index
  account: Account @index
  identity: Identity @index

  metadata: [NftMetadataEntry]
  mintedBlock: Block!
  "null = still in circulation. Filter `burnedBlockId: { isNull: true }` (Boolean cannot be indexed, §8b)"
  burnedBlock: Block @index
}

type NftMetadataEntry @jsonField { key: String!, value: String! }

type AssetAllowance @entity {
  id: ID!                        # assetId/owner/spender
  asset: Asset! @index
  owner: Account! @index
  spender: Account! @index
  amount: BigInt!                # remaining allowance
  totalSpent: BigInt!            # lifetime — free, same row already written
  updatedBlock: Block!
}

type AssetMetadata @entity {
  id: ID!                        # assetId/scope/key
  asset: Asset! @index
  scope: MetadataScope!          # Local | Global
  key: String!
  name: String
  value: String
  details: String                # lock status, expiry
  updatedBlock: Block!
}

enum MetadataScope { Local, Global }
```

### `Asset` changes

```diff
  type Asset @entity {
-   id: ID! # ticker
+   id: ID!                      # assetId
+   assetId: String! @index(unique: true)
    "current linked ticker, if any — NOT the asset's identity post-7.x"
    ticker: String @index(unique: false)
-   isUniquenessRequired: Boolean!        # pre-6.0 concept, dead
+   holderCount: Int!            # cheap: maintained where Holding rows are created/zeroed
+   metadata: [AssetMetadata!]! @derivedFrom(field: "asset")
+   holdings: [Holding!]! @derivedFrom(field: "asset")
+   nfts: [Nft!]! @derivedFrom(field: "asset")
-   holders: [AssetHolder]! @derivedFrom(field: "asset")
  }
```

### `AssetHolder` / `NftHolder`

Identity-level holding becomes **derived**. Two options:

- **(a) Remove**; consumers use `groupedAggregates(groupBy: [ASSET_ID, IDENTITY_ID]) { sum { amount } }` on `Holding`.
- **(b) Keep as a maintained rollup**, updated alongside `Holding`.

**Recommended: (b), keeping `AssetHolder`.** The SDK queries `assetHolders` and `nftHolders` directly **[V]**, and per [`../reference/polyx-balance-model.md`](../reference/polyx-balance-model.md) §9 a rollup keyed by `(asset, identity)` costs one row version per block that key is touched — cheap, since a given holder changes in few blocks. Option (a) would force an SDK rewrite for no correctness gain.

`NftHolder.nftIds` becomes `[BigInt]` (G10); the authoritative per-token record is `Nft`.

---

## Handler changes

**`src/mappings/entities/assets/mapAsset.ts`**

| Handler | Change |
|---|---|
| `handleAssetBalanceUpdated` | Write `Holding` at the **portfolio** grain from `rawFromHolder`/`rawToHolder`, then update the `AssetHolder` rollup. Today only the rollup is written. |
| `processUpdateReason` | Add the `controllerTransfer` branch (A7). |
| `handleAssetCreated` | Populate `assetId`; drop `isUniquenessRequired`. |
| **new** `handleApproval` | Upsert `AssetAllowance.amount`. |
| **new** `handleAllowanceSpent` | Set `amount = remainingAllowance` (chain already computed it — take it rather than subtracting, avoiding drift); increment `totalSpent`. |
| **new** `handleCreatedAssetTransfer` | Write an `AssetTransaction` with account-side from/to. If `pendingTransferId` is present, link to the `Instruction` — it is an `InstructionId` **[V]**, so pending transfers are already-modelled Instructions and need no new state machine. |
| **new** `handleSetAssetMetadataValue` etc. | Upsert `AssetMetadata`. |

`rawAssetHolderToAssetHolder` in `src/utils/portfolios.ts` already branches on `is8xChain` for the `MeshAssetHolder` (`{account}` | `{portfolio}`) shape **[V]** — extend it to return the `HolderKind` discriminator rather than collapsing to a DID.

**`src/mappings/entities/assets/mapNfts.ts`**

| Handler | Change |
|---|---|
| `handleNftHoldingsUpdates` | Write/move `Nft` rows per token id; maintain `Holding.nftCount` and the `NftHolder` rollup. Handles both `NFTPortfolioUpdated` (≤7.4) and `NFTHoldingsUpdated` (v8) — the rename is already registered **[V]**. |
| `handleNftCollectionCreated` | Unchanged. |

Minting sets `mintedBlock`; redemption sets `burnedBlock`.

---

## project.ts

```diff
  asset: {
+   Approval: ['handleApproval'],
+   AllowanceSpent: ['handleAllowanceSpent'],
-   CreatedAssetTransfer: [],
+   CreatedAssetTransfer: ['handleCreatedAssetTransfer'],
-   ControllerTransfer: [],
+   ControllerTransfer: ['handleControllerTransfer'],
-   SetAssetMetadataValue: [],
+   SetAssetMetadataValue: ['handleSetAssetMetadataValue'],
    # … and SetAssetMetadataValueDetails, RegisterAssetMetadataLocalType,
    #     RegisterAssetMetadataGlobalType, LocalMetadataKeyDeleted,
    #     MetadataValueDeleted, GlobalMetadataSpecUpdated, AssetTypeChanged
  }
```

`Approval` and `AllowanceSpent` are **new keys** — they are absent from `project.ts` entirely, not merely empty **[V]**.

---

## Backfill

Full resync (D5). `Holding` and `Nft` are built from the movement stream; both must be reconstructable from genesis.

**[I]** `Holding` correctness depends on every movement emitting an event. Add a reconciliation sample against `api.query.portfolio.portfolioAssetBalances` (or the v8 equivalent) writing `IndexerAnomaly` on mismatch — same pattern as [02](./02-polyx-ledger.md) §Reconciliation.

### NFT cardinality — measured, comfortable **[V]**

Counted on the live middleware endpoints:

| | Mainnet | Testnet |
|---|---|---|
| NFT collections | **6** | 228 |
| Assets (all) | 559 | 5,533 |
| `nftHolder` rows | 617 | 232 |
| NFT-bearing `assetTransactions` | 56,134 | 139,585 |
| Sampled NFTs per holder (n=100) | avg 10.1, max 50 | avg 46.0, max 2,724 |
| **Extrapolated total NFTs** | **~6,200** | **~10,700** |

Individual tokens number in the **thousands**, not millions. A row-per-token `Nft` entity is entirely comfortable — no partitioning, no special handling. This resolves the open question outright.

Mainnet has just **6** NFT collections, so this whole sub-domain is small; the value of `Nft` is addressability and provenance, not scale.

---

## Tests

- **Unit:** a portfolio-to-portfolio transfer within one identity updates two `Holding` rows and leaves `AssetHolder` unchanged (identity net zero) — the case the current model cannot express.
- **Unit:** an issuance creates `Holding` and increments `Asset.totalSupply` and `holderCount`.
- **Unit:** `AllowanceSpent` sets `amount` from `remainingAllowance`, not by subtraction.
- **Unit:** NFT transfer moves the `Nft` row and adjusts both `Holding.nftCount` values.
- **Unit:** redemption sets `burnedBlock` and leaves the row queryable.
- **Integration:** `SUM(Holding.amount) per (asset, identity)` equals `AssetHolder.amount`.
- **Integration:** `Asset.totalSupply` equals `SUM(Holding.amount)` across all holders.

---

## Consumer impact

| Consumer | Query | Impact |
|---|---|---|
| SDK | `assetHolders`, `nftHolders` | **Compatible** if `AssetHolder`/`NftHolder` are kept as rollups (recommended). `NftHolder.nftIds` narrows `[Int]` → `[BigInt]` — check SDK typings. |
| SDK | `assets` | `Asset.assetId` added, `isUniquenessRequired` removed, `holders` derived field may change shape. |
| SDK | `assetTransactions` | Gains account-side rows from `CreatedAssetTransfer`. Existing filters still work. |
| Portal | `assetTransactions` | Same. Its `fromPortfolioId`/`toPortfolioId` filters are unaffected and become better-served once `Holding` exists. |

New capability: `holdings(filter: { portfolioId: { equalTo: "did/1" } })` — the query neither consumer can express today.
