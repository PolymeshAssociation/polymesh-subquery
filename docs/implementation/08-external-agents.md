# 08 — External agents, compliance, and remaining cleanups

Consolidates the three `TickerExternalAgent*` entities, resolves the dual transfer-restriction model, and covers the small entities not addressed elsewhere.

**Entities:** `AssetAgent`/`AssetAgentHistory` (replacing three), `AgentGroup` (relation fix), `TransferManager` (removed), plus minor fixes.

---

## 8.1 External agents

### Problem

- Three entities for one concept: `TickerExternalAgent` (current), `TickerExternalAgentAction` (action log), `TickerExternalAgentHistory` (membership history).
- **G — `AgentGroup` has no `asset` relation.** Its id is `assetId/group_id`, but there is no `asset` field, so "all groups for asset X" requires parsing the id string.
- `TickerExternalAgentHistory.type: String!` is **untyped** where an enum belongs; `permissions: String` is **JSON-in-a-string** where the existing `PermissionsJson` jsonField belongs.
- `AgentGroupMembership.member: String!` is not an `Identity` relation.
- `Ticker`-prefixed naming is stale post-7.x.

### Target schema

```graphql
"Current agent membership for an asset."
type AssetAgent @entity @compositeIndexes(fields: [["assetId", "identityId"]]) {
  id: ID!                        # assetId/did
  asset: Asset! @index
  identity: Identity! @index
  group: AgentGroup
  permissions: PermissionsJson
  createdBlock: Block!
  updatedBlock: Block!
  createdEvent: Event!
}

"Append-only membership and permission history."
type AssetAgentHistory @entity {
  id: ID!                        # padId(block)/padId(eventIdx)/did  — D4
  asset: Asset! @index
  identity: Identity! @index
  type: AgentHistoryType!        # was an untyped String
  permissions: PermissionsJson   # was JSON-in-a-string
  eventIdx: Int!
  datetime: Date!
  createdBlock: Block!
  createdEvent: Event!
}

enum AgentHistoryType { AgentAdded, AgentRemoved, AgentPermissionsChanged, GroupChanged }

type AgentGroup @entity {
  id: ID!                        # assetId/groupId
  asset: Asset! @index           # ← was missing entirely
  groupId: Int!
  permissions: PermissionsJson   # was String
  members: [AgentGroupMembership!]! @derivedFrom(field: "group")
  createdBlock: Block!
  updatedBlock: Block!
}

type AgentGroupMembership @entity {
  id: ID!                        # assetId/groupId/did
  member: Identity! @index       # was String
  group: AgentGroup! @index
  createdBlock: Block!
  updatedBlock: Block!
}
```

`TickerExternalAgentAction` is **kept** but renamed `AssetAgentAction` — it records *what an agent did*, which is a different question from membership, and the SDK queries it **[V]**.

### Handler changes

`src/mappings/entities/externalAgents/` — `mapExternalAgent.ts`, `mapExternalAgentAction.ts`, `mapExternalAgentHistory.ts`. Entity targets and field types change; the event handling is already correct. All asset lookups already route through `getAssetId` **[V]**.

`mapExternalAgentAction.ts` has partial `is7Dot3Chain` coverage for the `sto` module's asset-id position **[V]** — move that into the legacy decoder table ([09](./09-infrastructure.md)) rather than leaving it inline.

### Consumer impact — breaking

| Consumer | Query | Change |
|---|---|---|
| SDK | `tickerExternalAgents` | Rename → `assetAgents`. |
| SDK | `tickerExternalAgentActions` | Rename → `assetAgentActions`. |
| SDK | `tickerExternalAgentHistories` | Rename → `assetAgentHistories`; `type` becomes an enum, `permissions` becomes a jsonField. |

Three renames plus two type changes. Mechanical, but the SDK queries all three **[V]** so it needs a coordinated release.

**[I]** If the rename churn is judged not worth it, keeping the `TickerExternalAgent*` names while fixing the `AgentGroup.asset` relation and the untyped fields captures most of the value. Worth asking the SDK team which they prefer.

---

## 8.2 Transfer restrictions — retire the dual model

`TransferManager` is documented in the schema as *"deprecated in favor of `TransferCompliance`"*, yet both are written unconditionally for the same pre-v5 events (`TransferManagerAdded`, `ExemptionsAdded`/`Removed` on `statistics`).

**Neither is queried by either consumer** **[V]** — the SDK reads transfer restrictions from chain.

**Action:** remove `TransferManager` and `TransferRestrictionTypeEnum`; keep `StatType`, `TransferCompliance`, `TransferComplianceExemption` as the single model. Pre-v5 events map into `StatType`/`TransferCompliance` with the era implicit in the block.

`mapTransferManager.ts` is deleted; `mapStatistics.ts` keeps its existing `transferRestrictionSpecVersion` / `statTypeAsEnumSpecVersion` handling, moved behind the decode layer.

Low risk: unobserved by both consumers, and it removes a documented duplicate.

---

## 8.3 Governance (PIPs)

`pips` is **4/20 handled**, and `Proposal`/`ProposalVote` are **unobserved by both consumers** **[V]** — which lowers the priority but does not make the gaps untrue.

Deferred to a later pass, recorded here so it is not lost:

- `ExecutionScheduled` / `ExpiryScheduled` — **when a passed PIP takes effect is unknown**, arguably the most important fact about a proposal.
- `ProposalRefund` — deposit refunds untracked, so `Proposal.balance` is stale after close.
- `PipClosed`, `PipSkipped` — closure reason and skip count lost.
- `SnapshotResultsEnacted`, `SnapshotCleared` — no `PipSnapshot` entity; `snapshotted: Boolean!` is a flag with no history.
- `ProposalVote.account: String!` is not a relation.

Also connects to [02](./02-polyx-ledger.md): PIP voting locks POLYX under `PIPS_LOCK_ID` **[V]**, and those locks are unmodelled. If [02](./02-polyx-ledger.md) tracks `AccountBalance.locks` properly, PIP locks should be included there even while the rest of this section waits.

---

## 8.4 Bridge

`bridge` is **1/17 handled** — only `Bridged`. Unhandled: `BridgeTxScheduled`, `BridgeTxFailed`, `BridgeTxScheduleFailed`, `BridgeLimitUpdated`, `ControllerChanged`, `AdminChanged`, `ExemptedUpdated`, `FrozenTx`, and others. Bridge failures and configuration changes are invisible.

`BridgeEvent` is **unobserved by both consumers** **[V]**, so this is low priority — but two things are worth fixing when touched:

1. `mapBridgeEvent.ts` has **no version branching at all**. Likely fine (the `BridgeTx` struct is POLYX-only and orthogonal to the ticker and staking changes), but unverified against an early-chain `Bridged` encoding.
2. It hardcodes `BigInt(amount) / BigInt(1000000)` — integer division that silently truncates the last six digits. Not a versioning issue, but wrong at the margin.

---

## 8.5 Small fixes

| Entity | Change |
|---|---|
| `Investment` | `offeringAssetId: String!` → `asset: Asset!` relation, matching `investor: Identity!`. SDK queries `investments` **[V]** — coordinate. |
| `Sto` | No change. 7/7 handled; `raisingAssetId: String!` is deliberately non-relational and documented. |
| `Venue` | No change. |
| `InstructionParty` | `portfolios: [Int]` cannot join to `Portfolio`. **[I]** Low priority; the `identity: String!` choice is documented and correct for off-chain legs. |
| `Portfolio` | Gains `holdings: [Holding!]! @derivedFrom` from [03](./03-holdings-nfts.md). Register the five `[]` portfolio events (`PreApprovedPortfolio`, `RevokePreApprovedPortfolio`, `AllowIdentityToCreatePortfolios`, `RevokeCreatePortfoliosPermission`, `UserPortfolios`) — asset-level pre-approval **is** modelled, so the portfolio-level asymmetry should go. |
| `Debug`, `FoundType` | Removed in [09](./09-infrastructure.md). |
| Confidential entities | No change. 19/26 handled, modelled on the settlement pattern, no legacy shapes. |

---

## Tests

- **Unit:** agent added → permissions changed → removed produces three `AssetAgentHistory` rows with the correct enum types.
- **Unit:** `AgentGroup` is queryable by `assetId` without string parsing — the G regression test.
- **Integration:** every `AssetAgent` has a corresponding `AgentAdded` history row.
- **Unit:** pre-v5 `TransferManagerAdded` writes a `TransferCompliance` row and no `TransferManager` row.
