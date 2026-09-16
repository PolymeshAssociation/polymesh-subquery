# 08 — External agents, compliance, and remaining cleanups

Renames the three `TickerExternalAgent*` entities to `Asset`-prefixed names, resolves the dual transfer-restriction model, and covers the small entities not addressed elsewhere.

**Entities:** `AssetAgent` (renamed from `TickerExternalAgent`) and `AssetAgentHistory` (renamed
from `TickerExternalAgentHistory`) — what actually *merges* is the two handler modules that write
them, both firing on the same `externalagents` events. `AssetAgentAction` (renamed from
`TickerExternalAgentAction`) is a straight rename with an unchanged shape — it answers "what did
this agent do", a different question from membership, so it stays a separate entity. Plus
`AgentGroup` (relation fix), `TransferManager` (removed), plus minor fixes.

---

## 8.1 External agents

### Problem

- Three entities, stale `Ticker`-prefixed naming post-7.x, and two of the three duplicate their
  write path: `TickerExternalAgent` (current membership) and `TickerExternalAgentHistory`
  (membership history) both write from handlers that fire on the same `externalagents` events
  (`AgentAdded`/`AgentRemoved`/`GroupChanged`) — that duplication is what's worth consolidating.
  `TickerExternalAgentAction` (action log) is a different concern entirely: it is driven from
  *every* chain event via a 20-pallet lookup table, not from `externalagents`, so it is renamed but
  kept as its own entity.
- **G — `AgentGroup` has no `asset` relation.** Its id is `assetId/group_id`, but there is no `asset` field, so "all groups for asset X" requires parsing the id string.
- `TickerExternalAgentHistory.type: String!` is **untyped** where an enum belongs.
- `AgentGroupMembership.member: String!` is not an `Identity` relation.

### Target schema (as implemented)

Field provenance is `createdEvent`/`updatedEvent` (Event-grain, per the D13 rework on
`redesign/07-schema-invariants`) rather than the `createdBlock`/`updatedBlock` this plan originally
sketched — every other entity in the schema made that same move, so these follow it too. `eventIdx`
/ `datetime` are not stored as separate copies; they are reachable through `createdEvent`.

```graphql
"Current agent membership for an asset."
type AssetAgent @entity @compositeIndexes(fields: [["asset", "identity"]]) {
  id: ID!                        # assetId/did
  asset: Asset! @index
  identity: Identity! @index     # was `caller` on TickerExternalAgent
  group: AgentGroup
  permissions: String            # kept String — see note below
  createdEvent: Event!
  updatedEvent: Event!
}

"Append-only membership and permission history."
type AssetAgentHistory @entity {
  id: ID!                        # blockId/eventIdx/did
  asset: Asset! @index
  identity: Identity! @index
  type: AgentHistoryType!        # was an untyped String
  permissions: String            # kept String — see note below
  createdEvent: Event!
  updatedEvent: Event!
}

enum AgentHistoryType { AgentAdded, AgentRemoved, AgentPermissionsChanged, GroupChanged }

type AgentGroup @entity {
  id: ID!                        # assetId/groupId
  asset: Asset! @index           # ← was missing entirely
  permissions: String            # kept String — see note below
  members: [AgentGroupMembership!]! @derivedFrom(field: "group")
  createdEvent: Event!
  updatedEvent: Event!
}

type AgentGroupMembership @entity {
  id: ID!                        # assetId/groupId/did
  member: Identity! @index       # was String
  group: AgentGroup! @index
  createdEvent: Event!
  updatedEvent: Event!
}
```

**`permissions` stays `String` (JSON-in-a-string), not the `PermissionsJson` jsonField this plan
originally proposed.** `PermissionsJson`'s shape (`assets`/`portfolios`/`transactions`/
`transactionGroups`, each `{type, values}`) was built for the secondary-key permission model. An
`AgentGroup`'s on-chain permission set is `ExtrinsicPermissions` (`Whole | These<PalletPermissions>
| Except<PalletPermissions>`, nesting per-pallet dispatchable names) — a different, richer
structure that would need a lossy flattening to fit `PermissionsJson`. Typing it correctly (a
dedicated jsonField shaped for `ExtrinsicPermissions`, or a flattening scheme) is a separate
modeling exercise, deferred rather than forced into the wrong shape here.

`AssetAgent.group` / `.permissions` are populated by `AgentAdded` but not kept current by
`GroupChanged` (only `AssetAgentHistory` is updated there) — see the code comment in
`mapExternalAgent.ts::handleExternalAgentAdded`. Wiring both paths together is a follow-up.

`TickerExternalAgentAction` is **kept** but renamed `AssetAgentAction`, shape unchanged — it
records *what an agent did*, which is a different question from membership, and the SDK queries it
**[V]**. `caller` stays `caller` there (not renamed to `identity`) — deliberately asymmetric, see
the entity's schema docstring.

### Handler changes

`src/mappings/entities/externalAgents/` — `mapExternalAgent.ts`, `mapExternalAgentAction.ts`, `mapExternalAgentHistory.ts`. Entity targets and field types change; the event handling is already correct. All asset lookups already route through `getAssetId` **[V]**.

`mapExternalAgentAction.ts` has partial `is7Dot3Chain` coverage for the `sto` module's asset-id
position **[V]** — plan 09 moves that into the legacy decoder table; left inline here, unrelated to
this commit's scope.

### Consumer impact — breaking

| Consumer | Query | Change |
|---|---|---|
| SDK | `tickerExternalAgents` | Rename → `assetAgents`; `callerId` filters/selections → `identityId`. |
| SDK | `tickerExternalAgentActions` | Rename → `assetAgentActions`. |
| SDK | `tickerExternalAgentHistories` | Rename → `assetAgentHistories`; `type` becomes an enum (`permissions` stays a String — see the modeling note above). |

Three renames plus one type change (`type` → enum) plus the `caller`→`identity` field rename.
Mechanical, but the SDK queries all three **[V]** so it needs a coordinated release.

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
