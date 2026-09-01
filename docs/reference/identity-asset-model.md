# Identity / Account and Asset Lifecycle — Current Model vs. Ground-Up

Companion to [`polyx-balance-model.md`](./polyx-balance-model.md), same method: what the chain emits, what the indexer stores, where the gaps are, and what a from-scratch model looks like.

**[V]** = verified against chain source or generated types. **[I]** = inference needing confirmation.

> **Methodology note.** `polymesh-types/src/polkadot/types-lookup.ts` (built from chain 8.0.1) is authoritative for event *shapes*, but polkadot-js **camelCases variant names** in the generated TS — it renders `NFTHoldingsUpdated` as `NftHoldingsUpdated`. For event *names*, the Rust source is authoritative. One apparent casing bug in `project.ts` dissolved on checking this.

---

# Part 1 — Identity & Account

## 1.1 What exists today

| Entity | Shape |
|---|---|
| `Identity` | `did`, `primaryAccount: String!`, `secondaryKeysFrozen`, `secondaryAccounts @derivedFrom(Account.identity)` |
| `Account` | `address`, `identity: Identity`, `permissions: Permissions`, `eventId` |
| `AccountHistory` | `account: String!`, `identity: String!`, `eventId`, `permissions: PermissionsJson` |
| `Permissions` | entity, one per account |
| `PermissionsJson` | `@jsonField` — the same shape again, for `AccountHistory` |
| `ChildIdentity` | `child: Identity!`, `parent: Identity!` |
| `MultiSig` | `address: String!`, `creator: Identity!`, `creatorAccount: Account!`, `signaturesRequired` |
| `MultiSigAdmin` | `multisig`, `identityId: String!`, `status` |
| `MultiSigSigner` | `multisig`, `signerType`, `signerValue: String!`, `status` |

## 1.2 Gaps

### G1 — `Identity.secondaryAccounts` includes the primary account **[V]**

`secondaryAccounts` is `@derivedFrom(field: "identity")` on `Account`. But `handleDidCreated` ([`mapIdentities.ts:189-196`](../../src/mappings/entities/identities/mapIdentities.ts#L189)) creates the **primary** account with `identityId: did` set:

```ts
const account = createAccount({ identityId: did, permissionsId: address, eventId, address, datetime }, blockId);
```

So the derived list returns primary **and** secondary keys. Worse, `Account` has no `role`/`isPrimary` discriminator, so a consumer cannot filter the primary out without string-comparing against `Identity.primaryAccount`. The field name asserts something the data does not honour.

### G2 — `primaryAccount` is a `String`, not a relation

`Identity.primaryAccount: String!` while `Account.identity: Identity` is a proper relation. Asymmetric: no FK integrity, no join, and the "current primary key" cannot be traversed to its `Account` (or its permissions) in one query.

### G3 — No key-rotation history

`PrimaryKeyUpdated` overwrites `Identity.primaryAccount` in place. `AccountHistory` is a partial log — untyped `String` columns, an `eventId`, and **no validity interval**. There is no entity answering:

- Who was the primary key at block N?
- When did account A become secondary on identity D, and when did it leave?
- What were A's permissions during that window?

SubQuery historical mode makes the first answerable by `blockHeight` on `Identity`, but only one block at a time — you cannot list rotations, count them, or aggregate them. For a domain where **key rotation is a security-relevant event**, that is a significant hole.

### G4 — Permissions shape duplicated

`Permissions` (entity) and `PermissionsJson` (`@jsonField`) carry the same four fields. Two definitions to keep in sync, and a permissions change on an account is not itself a first-class historical record.

### G5 — `MultiSig` is not linked to its `Account`

A multisig **is** an account — it holds POLYX, holds assets, signs. But `MultiSig.address: String!` is a bare string with no relation to `Account`, so the multisig's balance and its multisig-ness cannot be traversed in one query. Meanwhile `MultiSigAdmin.identityId: String!` is a string while `MultiSig.creator: Identity!` is a relation — inconsistent within the same cluster.

### G6 — Child identities: feature removed at v8, stale rows retained **[V]**

`ChildDidCreated` exists at v7.4.0 (`pallets/identity/src/keys.rs`, `lib.rs`) and is **absent at v8.0.0**; no child-identity call or event survives in the v8 runtime.

`ChildIdentity` rows created pre-v8 therefore persist indefinitely with no unlink event to retire them. **[I]** Whether the chain unlinked existing children during the upgrade needs checking — if it did so silently (storage migration, no event), the index now asserts parent/child links that no longer exist.

This generalises to a pattern worth naming: **when a chain feature is removed, the indexer keeps its last-known state forever.** Nothing in the current design detects it.

### G7 — Unhandled identity events

Registered with an empty handler list: `AuthorizationRetryLimitReached`, `CddClaimsInvalidated`, `CddRequirementForPrimaryKeyUpdated`. `CddClaimsInvalidated` in particular is a compliance-relevant state change.

## 1.3 From scratch

One idea replaces three of the gaps: **model key membership as an explicit, time-bounded relationship** rather than as a mutable pointer plus a loose log.

```graphql
type Identity @entity {
  id: ID!                        # did
  did: String! @index(unique: true)
  "current primary — a real relation, not a string"
  primaryKey: Account!
  secondaryKeysFrozen: Boolean!
  keyCount: Int!
  "all key assignments, current and historical"
  keys: [IdentityKey!]! @derivedFrom(field: "identity")
  createdBlock: Block!
}

"""
One row per (account, identity, role) membership interval. Append-only:
a rotation closes the old row and opens a new one.
Replaces AccountHistory, Identity.primaryAccount and Identity.secondaryAccounts.
"""
type IdentityKey @entity {
  id: ID!                        # did/address/fromBlock
  identity: Identity! @index
  account: Account! @index
  role: KeyRole!                 # Primary | Secondary | MultiSigSigner
  permissions: PermissionsJson

  validFromBlock: Block!
  "null = currently active. Indexed via the FK; filter with `validToBlockId: { isNull: true }`"
  validToBlock: Block @index
  addedReason: EventIdEnum!
  removedReason: EventIdEnum
}

enum KeyRole { Primary, Secondary }
```

This makes every question in G3 a single indexed query, makes G1 impossible by construction (role is explicit), and subsumes `AccountHistory` entirely.

For G5, make the multisig a **specialisation of an account** rather than a parallel universe:

```graphql
type Account @entity {
  id: ID!                        # address
  address: String! @index(unique: true)
  identity: Identity
  "set when this account is a multisig — the account IS the multisig"
  multiSig: MultiSig
  keyAssignments: [IdentityKey!]! @derivedFrom(field: "account")
}

type MultiSig @entity {
  id: ID!                        # address
  account: Account!              # relation, not a bare string
  creator: Identity!
  signaturesRequired: Int!
  admins: [MultiSigAdmin!]! @derivedFrom(field: "multisig")
}
```

`MultiSigAdmin.identityId` becomes `admin: Identity!`, matching `creator`.

**Entity change:** `+1` (`IdentityKey`), `−1` (`AccountHistory`), `Permissions` collapses into the jsonField already used. Net zero, with full key history gained.

---

# Part 2 — Asset lifecycle

## 2.1 What exists today

| Entity | Grain |
|---|---|
| `Asset` | per asset: `ticker`, `name`, `isNftCollection`, `totalSupply`, `totalTransfers`, `owner`, `isFrozen` |
| `AssetHolder` | `id: assetId/did` — **identity level** |
| `NftHolder` | `id: assetId/did`, `nftIds: [Int]` — **identity level, ids in an array** |
| `AssetTransaction` | movement log (issue / redeem / transfer) |
| `Portfolio` | `did/number`, name, custodian |
| `PortfolioMovement` | intra-identity movement log |
| `AssetDocument`, `Funding`, `AssetMandatoryMediator`, `AssetPreApproval`, `TickerReservation` | supporting |

## 2.2 Gaps

### G8 — There is no portfolio-level holding entity at all **[V]**

Searching the schema for any portfolio-keyed balance returns nothing. `AssetHolder` and `NftHolder` are both keyed `assetId/did`.

So the index can answer *"what does identity D hold of asset A"* but **not** *"what does portfolio D/1 hold of asset A"* — that requires replaying every `AssetTransaction` and `PortfolioMovement` touching the portfolio and summing. This directly fails the requirement to track holdings down to portfolio level, and it is the single largest gap in the asset domain.

`Portfolio` also has no `holdings` derived field — the entity exists purely as a label with a custodian.

### G9 — No per-NFT entity **[V]**

NFTs exist only as integers inside `NftHolder.nftIds: [Int]`. There is no `Nft` entity. Consequences:

- *"Who owns NFT #42 of collection C?"* → scan every `NftHolder` row for that collection and search inside arrays.
- *"Provenance of NFT #42"* → not answerable except by replaying all transactions and filtering array membership.
- Per-NFT metadata has nowhere to live.

For a chain that markets NFT support, individual tokens being unaddressable is a structural gap, not a nicety.

### G10 — `nftIds` type is inconsistent across entities **[V]**

`NftHolder.nftIds: [Int]` · `AssetTransaction.nftIds: [BigInt]` · `PortfolioMovement.nftIds: [BigInt]`

The same concept typed two ways. `Int` is the odd one out and is the narrower type.

### G11 — The entire v8 account-level asset layer is unindexed **[V]**

v8 added an ERC20-style layer (alongside the `revive` pallet / EVM compatibility). From `types-lookup.ts:4576-4599`:

```
Approval             { owner: AccountId32, spender: AccountId32, assetId, amount }
AllowanceSpent       { owner, spender, assetId, amountSpent, remainingAllowance }
CreatedAssetTransfer { assetId, from: AccountId32, to: AccountId32, amount, memo, pendingTransferId: Option<u64> }
```

Coverage:
- `Approval` — **not present in `project.ts` at all**
- `AllowanceSpent` — **not present in `project.ts` at all**
- `CreatedAssetTransfer` — registered with `[]`, no handler

Two things follow. First, a **delegated-transfer (allowance) mechanism exists on chain and is completely invisible** to the index. Second — and more structurally — these events are keyed by `AccountId32`, **not** by DID or portfolio. v8 introduced asset movement that bypasses the identity/portfolio model entirely, and a holdings model keyed only at identity level cannot represent it. `pendingTransferId` further implies a two-phase transfer with state the index does not model.

### G12 — `ControllerTransfer` is unhandled twice over **[V]**

`asset.ControllerTransfer` is registered `[]` in `project.ts`, *and* `processUpdateReason` falls through on the `ControllerTransfer` variant of `HoldingsUpdateReason` (audit A7). Forced transfers are therefore missing from both paths.

### G13 — Asset metadata is entirely unindexed **[V]**

All registered `[]`: `SetAssetMetadataValue`, `SetAssetMetadataValueDetails`, `RegisterAssetMetadataLocalType`, `RegisterAssetMetadataGlobalType`, `LocalMetadataKeyDeleted`, `MetadataValueDeleted`, `GlobalMetadataSpecUpdated`, `AssetTypeChanged`, `CustomAssetTypeExists`, `CustomAssetTypeRegistered`. There is no `AssetMetadata` entity.

### G14 — Portfolio permission/pre-approval events unhandled

`PreApprovedPortfolio`, `RevokePreApprovedPortfolio`, `AllowIdentityToCreatePortfolios`, `RevokeCreatePortfoliosPermission`, `UserPortfolios` — all `[]`. Note the asymmetry: `AssetPreApproval` **is** modelled at asset level, but the portfolio-level equivalent is dropped.

### G15 — Naming and legacy debt

`Asset.id # ticker` (stale comment — it is an assetId post-7.x); `isUniquenessRequired` is a pre-6.0 concept still on every row; no `holderCount` despite `totalSupply`/`totalTransfers` being maintained.

## 2.3 From scratch

### Hold balances at the finest grain the chain uses, and roll up from there

The core correction: the chain moves assets between **portfolios** (and, on v8, between **accounts**). Identity-level holding is a *derived* view, not the source of truth. Today it is the only thing stored, which is why portfolio holdings are unreachable.

```graphql
"""
One row per (asset, holder) at the FINEST grain the chain uses.
Identity-level holdings are derived from these, not stored as the primary truth.
"""
type Holding @entity {
  id: ID!                        # assetId/portfolioId  or  assetId/address
  asset: Asset! @index

  holderKind: HolderKind!        # Portfolio | Account
  portfolio: Portfolio           # set when holderKind = Portfolio
  account: Account               # set when holderKind = Account (v8 account-level)
  "denormalised: always the owning DID where one exists — makes identity rollup a groupBy"
  identity: Identity @index

  amount: BigInt!                # fungible
  nftCount: Int!                 # non-fungible, count only; ids live on Nft
  updatedBlock: Block!
}

enum HolderKind { Portfolio, Account }
```

With this, identity-level holdings become `groupedAggregates(groupBy: [ASSET_ID, IDENTITY_ID]) { sum { amount } }` — or a maintained `AssetHolder` rollup if the read pattern justifies it (same Tier-1/Tier-2 reasoning as `polyx-balance-model.md` §9: a rollup costs one version per block its key is touched).

### Make individual NFTs addressable

```graphql
type Nft @entity {
  id: ID!                        # assetId/nftId
  asset: Asset! @index           # the collection
  nftId: BigInt!                 # BigInt everywhere — resolves G10

  "current location; exactly one of these is set"
  portfolio: Portfolio @index
  account: Account @index
  identity: Identity @index

  metadata: [NftMetadataEntry]   # jsonField; per-token attributes
  mintedBlock: Block!
  "null = still in circulation. Filter with `burnedBlockId: { isNull: true }`"
  burnedBlock: Block @index
}
```

Provenance then needs no new entity — it is `AssetTransaction` filtered by `nftId`, provided that column is materialised for single-NFT movements. Ownership is a single indexed read.

### Model the v8 account-level layer

```graphql
type AssetAllowance @entity {
  id: ID!                        # assetId/owner/spender
  asset: Asset! @index
  owner: Account! @index
  spender: Account! @index
  amount: BigInt!                # remaining allowance
  totalSpent: BigInt!            # lifetime, free — same row is already written
  updatedBlock: Block!
}
```

Fed by `Approval` (set) and `AllowanceSpent` (decrement, using `remainingAllowance` as the authoritative value rather than subtracting — the chain already computed it, so take it and avoid drift).

`CreatedAssetTransfer` writes an `AssetTransaction` with account-side from/to, and `pendingTransferId` needs **[I]** investigation — if pending transfers can be cancelled, they need their own state entity rather than being recorded as completed movements.

### Asset lifecycle as explicit state

```graphql
type Asset @entity {
  id: ID!                        # assetId
  assetId: String! @index(unique: true)
  "current ticker, if one is linked — nullable, and NOT the identity of the asset"
  ticker: String @index
  isNftCollection: Boolean!
  isFrozen: Boolean!

  totalSupply: BigInt!
  totalTransfers: BigInt!
  holderCount: Int!              # cheap: maintained where Holding rows are created/zeroed

  metadata: [AssetMetadataEntry!]! @derivedFrom(field: "asset")
  holdings: [Holding!]! @derivedFrom(field: "asset")
  nfts: [Nft!]! @derivedFrom(field: "asset")
}
```

Plus an `AssetMetadata` entity closing G13, and `AssetTransaction` extended with `holderKind` on each side so account-level and portfolio-level movements share one ledger — the same entry-centric argument as `polyx-balance-model.md` §7.1 applies if per-holder queries become the dominant read.

**Entity change:** `+Holding`, `+Nft`, `+AssetAllowance`, `+AssetMetadata`; `−AssetHolder`, `−NftHolder` (become rollups or derived). Net `+2`.

---

# Part 3 — Cross-cutting patterns

Three failure modes recur across POLYX, identity, and assets. They are worth fixing as *patterns*, not as individual bugs.

**P1 — Current-state-only where history is the question.** Key rotations, custodian changes, allowance changes, multisig signer changes are all stored as mutable pointers. SubQuery historical answers "at block N" one row at a time, but cannot list, count, or aggregate changes. Anything security- or compliance-relevant should be an explicit interval record (`IdentityKey` is the template).

**P2 — Holdings stored at the wrong grain.** Both POLYX (`BalanceTypeEnum` conflating pools) and assets (identity-level only) store a *derived* view as the source of truth, making the finer grain unrecoverable. Store the finest grain the chain uses; roll up for reads.

**P3 — Enum entries without handlers give a false sense of coverage.** `schema.graphql` lists many events that `project.ts` registers as `[]` or omits entirely, so the enum implies coverage that does not exist. The metadata-sync script proposed in `../architecture-review.md` §3 should emit an explicit **"in enum, no handler"** report so this stays visible rather than accumulating silently.

And one new pattern from G6:

**P4 — Removed chain features leave orphaned state.** `ChildIdentity` will hold pre-v8 links forever. Any entity whose backing feature is removed needs an explicit retirement step at the upgrade boundary, and the `ChainUpgrade` entity proposed in `../architecture-review.md` §4.3 is the natural place to trigger it.

---

# Open questions

1. **G6** — did the v8 upgrade unlink existing child identities via storage migration (no event)? If so, `ChildIdentity` needs a one-off retirement at the boundary block.
2. **G11** — can a `CreatedAssetTransfer` with a `pendingTransferId` be cancelled or expire? Determines whether pending transfers need their own entity and state machine.
3. **G8** — is portfolio-level holding wanted as a maintained entity, or is identity-level plus movement replay acceptable for the known consumers? This decides `Holding` vs. keeping `AssetHolder`.
4. **G9** — how many NFTs exist per collection in practice? A `Nft` row per token is fine at thousands, needs thought at tens of millions.
5. **Backfill** — `Holding`, `Nft`, and `IdentityKey` all require replay from genesis. Same reindex-window question as the balance model.
6. **Do consumers use `Identity.secondaryAccounts` today** (G1)? If so, fixing the semantics is a breaking change and needs the same additive → deprecate → remove staging.
7. **G13** — is asset metadata wanted in the index, or deliberately excluded as chain-queryable? It is a sizeable ingestion surface if adopted.
