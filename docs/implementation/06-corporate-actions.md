# 06 — Corporate actions, checkpoints, ballots

Fills the largest coverage hole in the schema: three pallets with **zero** handled events.

**Entities:** `CorporateAction` (new), `Checkpoint` (new), `CheckpointSchedule` (new), `CorporateBallot` (new), `CorporateBallotVote` (new), `Distribution`/`DistributionPayment` (linked).

**Status: in scope, low priority (D6).** Sequenced after the correctness and model work. Nothing else depends on it, and nothing in it depends on the other plans — so it can land whenever capacity allows, including in parallel.

**Why it can wait despite being the largest coverage gap:** it is *purely additive* for consumers, so no coordination is required; the events are near-stable across versions (one legacy decoder entry, verified below); and no existing data is wrong today — the entities simply do not exist yet. Contrast with plan [01](./01-claims.md), where the index currently returns *incorrect* compliance answers.

---

## Problem

| Pallet | Handled | Empty | Entity exists? |
|---|---|---|---|
| `corporateAction` | **0** | 8 | No |
| `corporateBallot` | **0** | 6 | No |
| `checkpoint` | **0** | 4 | No |

`Distribution` and `DistributionPayment` exist and are fed (`capitalDistribution` is 4/4), and **both consumers query them** **[V]**. But the corporate action that *defines* a distribution is not indexed, so:

- **Record date is unknown** → entitlement cannot be reconstructed or audited.
- **Withholding tax is unknown** — default and per-DID — yet `DistributionPayment` records a `tax` amount whose basis is unindexed.
- **Target identities are unknown** → "who was this CA for" is unanswerable.
- **Checkpoints are absent** — the balance-at-record-date snapshot that makes a distribution verifiable.
- **Shareholder ballots are entirely unindexed**, `VoteCast` included.

For a securities chain these are core domain objects sitting directly beneath a live consumer surface.

---

## Target schema

```graphql
type CorporateAction @entity @compositeIndexes(fields: [["assetId", "kind"]]) {
  id: ID!                        # assetId/localId
  asset: Asset! @index
  localId: Int!
  kind: CorporateActionKind!
  declarationDate: Date!
  recordDate: Date
  "the checkpoint the record date resolved to, once created"
  checkpoint: Checkpoint
  details: String
  "null = applies to all holders"
  targetIdentities: [String!]
  targetTreatment: TargetTreatment
  defaultWithholdingTax: BigInt
  didWithholdingTax: [DidTax]
  documents: [String!]
  isRemoved: Boolean!
  createdBlock: Block!
  updatedBlock: Block!
}

enum CorporateActionKind {
  PredictableBenefit, UnpredictableBenefit, IssuerNotice, Reorganization, Other
}
enum TargetTreatment { Include, Exclude }
type DidTax @jsonField { did: String!, tax: BigInt! }

type Checkpoint @entity @compositeIndexes(fields: [["assetId", "checkpointId"]]) {
  id: ID!                        # assetId/checkpointId
  asset: Asset! @index
  checkpointId: Int!
  totalSupply: BigInt!
  datetime: Date!
  "set when created by a schedule rather than manually"
  schedule: CheckpointSchedule
  createdBlock: Block!
}

type CheckpointSchedule @entity {
  id: ID!                        # assetId/scheduleId
  asset: Asset! @index
  scheduleId: Int!
  "v6+ — explicit list of scheduled checkpoint timestamps (ScheduleCheckpoints.pending)"
  pendingCheckpoints: [Date!]
  "pre-v6 only — the period-based model (CheckpointSchedule). Null from v6 onward."
  period: String
  start: Date
  remaining: Int
  nextCheckpointAt: Date
  "null while active"
  removedBlock: Block @index
  createdBlock: Block!
}

type CorporateBallot @entity {
  id: ID!                        # assetId/localId
  asset: Asset! @index
  corporateAction: CorporateAction!
  startDate: Date!
  endDate: Date!
  meta: String                   # title, motions
  rcv: Boolean!                  # ranked-choice voting enabled
  isRemoved: Boolean!
  votes: [CorporateBallotVote!]! @derivedFrom(field: "ballot")
  createdBlock: Block!
  updatedBlock: Block!
}

type CorporateBallotVote @entity {
  id: ID!                        # padId(block)/padId(eventIdx)  — D4
  ballot: CorporateBallot! @index
  voter: Identity! @index
  "per-motion weights, in motion order"
  votes: [BallotVoteEntry]
  createdBlock: Block!
}

type BallotVoteEntry @jsonField { power: BigInt!, fallback: Int }
```

### Linking existing entities

```diff
  type Distribution @entity {
+   corporateAction: CorporateAction!
+   checkpoint: Checkpoint
  }
```

This is the point of the plan: a `DistributionPayment.tax` becomes explicable, because the CA that set the rate is now a row.

---

## Handler changes

**New file:** `src/mappings/entities/assets/mapCorporateAction.ts`

| Handler | Event | Action |
|---|---|---|
| `handleCAInitiated` | `corporateAction.CAInitiated` | Create `CorporateAction`. |
| `handleCARemoved` | `CARemoved` | Set `isRemoved`. |
| `handleRecordDateChanged` | `RecordDateChanged` | Update `recordDate`, link `checkpoint`. |
| `handleDefaultTargetIdentitiesChanged` | `DefaultTargetIdentitiesChanged` | Asset-level default. **[I]** may need its own row rather than living on each CA. |
| `handleDefaultWithholdingTaxChanged` | `DefaultWithholdingTaxChanged` | Asset-level default rate. |
| `handleDidWithholdingTaxChanged` | `DidWithholdingTaxChanged` | Upsert into `didWithholdingTax`. |
| `handleCALinkedToDoc` | `CALinkedToDoc` | Append to `documents`. |

**New file:** `src/mappings/entities/assets/mapCheckpoint.ts`

| Handler | Event |
|---|---|
| `handleCheckpointCreated` | `checkpoint.CheckpointCreated` |
| `handleScheduleCreated` | `ScheduleCreated` |
| `handleScheduleRemoved` | `ScheduleRemoved` |

**New file:** `src/mappings/entities/assets/mapCorporateBallot.ts` — `Created`, `MetaChanged`, `RangeChanged`, `RCVChanged`, `Removed`, `VoteCast`.

All asset references route through `getAssetId` / `getCaIdValue` so the 7.x ticker→assetId migration is handled **[V]**.

---

## Verified event shapes, v5.4.3 → v8.0.2

Walked event-by-event against the Rust source. **The domain is far more stable than expected** — one arity change and one removed event across four years.

### Stable arity; only `Ticker` → `AssetId` at 7.x

Already handled by `getAssetId` / `getCaIdValue`, which branch on `is7xChain` **[V]**.

| Event | Signature (unchanged v5.4.3 → v8.0.0) | Args |
|---|---|---|
| `CAInitiated` | `(EventDid, CAId, CorporateAction, CADetails)` | 4 |
| `CARemoved` | `(EventDid, CAId)` | 2 |
| `RecordDateChanged` | `(EventDid, CAId, CorporateAction)` | 3 |
| `CALinkedToDoc` | `(IdentityId, CAId, Vec<DocumentId>)` | 3 |
| `DefaultTargetIdentitiesChanged` | `(IdentityId, Ticker→AssetId, TargetIdentities)` | 3 |
| `DefaultWithholdingTaxChanged` | `(IdentityId, Ticker→AssetId, Tax)` | 3 |
| `DidWithholdingTaxChanged` | `(IdentityId, Ticker→AssetId, IdentityId, Option<Tax>)` | 4 |
| `MaxDetailsLengthChanged` | `(IdentityId, u32)` | 2 |
| `CheckpointCreated` | `(Option<EventDid→IdentityId>, Ticker→AssetId, CheckpointId, Balance, Moment)` | 5 |
| `MaximumSchedulesComplexityChanged` | `(IdentityId, u64)` | 2 |
| **All six ballot events** | `Created`, `VoteCast`, `RangeChanged`, `MetaChanged`, `RCVChanged`, `Removed` | **byte-identical across all four tags** |

The `CorporateAction` struct itself is **identical across v5.4.3, v6.3.5, v7.0.0, v7.4.0, v8.0.0** — same six fields, same order: `kind`, `decl_date`, `record_date`, `targets`, `default_withholding_tax`, `withholding_tax`.

`CheckpointCreated`'s first arg changes `EventDid` → `IdentityId` at v6; both are DIDs, so this is cosmetic.

### Real change — `ScheduleCreated` / `ScheduleRemoved` gained an arg at v6.0.0 **[V]**

```
v5.4.3      ScheduleCreated(EventDid,   Ticker,  StoredSchedule)              — 3 args
v6.0.0+     ScheduleCreated(IdentityId, Ticker,  ScheduleId, ScheduleCheckpoints) — 4 args
v7.0.0+     ScheduleCreated(IdentityId, AssetId, ScheduleId, ScheduleCheckpoints) — 4 args
```

`ScheduleRemoved` changed identically. Two things moved at once: **`ScheduleId` was inserted at index 2**, and the payload type changed from `StoredSchedule` to `ScheduleCheckpoints`.

This is exactly the A1/A2 failure class — a positional insertion with no arity guard — so it needs a **legacy decoder entry** ([09](./09-infrastructure.md)):

```ts
registerLegacy('checkpoint', 'ScheduleCreated', [
  { range: [0, 5_999_999],       arity: 3, decode: ([did, ticker, stored]) => ({ did, ticker, scheduleId: stored.id, schedule: stored.schedule }) },
  { range: [6_000_000, Infinity], arity: 4, decode: ([did, asset, id, sched]) => ({ did, asset, scheduleId: id, schedule: sched }) },
]);
```

The v5 schedule id is still recoverable — `StoredSchedule { schedule, id, at, remaining }` carries it nested **[V]**, so pre-v6 rows are not lossy, just decoded differently.

The payload types differ in kind, not just shape: v5 `CheckpointSchedule` is period-based (start + period + remaining count), v6+ `ScheduleCheckpoints { pending: BTreeSet<Moment> }` is an explicit timestamp list. `CheckpointSchedule.period` / `remaining` on the target entity should be **nullable**, populated only for pre-v6 rows.

### Removed event — `CAATransferred` **[V]**

`CAATransferred(IdentityId, Ticker, IdentityId)` existed at v5.4.3 and is **gone from v6.0.0** — the Corporate Action Agent concept was replaced by external agents.

It is already in `schema.graphql:463-464` documented as deprecated from 6.0.0, but is **not registered in `project.ts`**. For pre-6.0 history this is an unindexed CAA-transfer record. **[I]** Decide whether pre-6.0 CAA transfers matter; if so, register it and route to `AssetAgentHistory` ([08](./08-external-agents.md)). If not, leave it unregistered with a comment so the sync-metadata report does not re-flag it.

### Implication

The `[I]` caveat that previously sat here is **resolved**. `CAInitiated` and 15 of the 18 events need no version branching beyond the existing asset-id helpers. Only the two schedule events need a legacy decoder entry, and one removed event needs a decision.

This makes 06 **lower-risk than originally assessed** — the ratio of new coverage to version complexity is the best in the set.

---

## project.ts

All 18 events move from `[]` to handlers:

```diff
  corporateAction: {
-   CAInitiated: [], CALinkedToDoc: [], CARemoved: [],
-   DefaultTargetIdentitiesChanged: [], DefaultWithholdingTaxChanged: [],
-   DidWithholdingTaxChanged: [], MaxDetailsLengthChanged: [], RecordDateChanged: [],
+   CAInitiated: ['handleCAInitiated'],
+   CALinkedToDoc: ['handleCALinkedToDoc'],
+   CARemoved: ['handleCARemoved'],
+   DefaultTargetIdentitiesChanged: ['handleDefaultTargetIdentitiesChanged'],
+   DefaultWithholdingTaxChanged: ['handleDefaultWithholdingTaxChanged'],
+   DidWithholdingTaxChanged: ['handleDidWithholdingTaxChanged'],
+   MaxDetailsLengthChanged: [],          # chain config, no entity
+   RecordDateChanged: ['handleRecordDateChanged'],
  },
  checkpoint: {
+   CheckpointCreated: ['handleCheckpointCreated'],
+   ScheduleCreated: ['handleScheduleCreated'],
+   ScheduleRemoved: ['handleScheduleRemoved'],
+   MaximumSchedulesComplexityChanged: [],  # chain config
  },
  corporateBallot: {
+   Created: ['handleBallotCreated'],
+   MetaChanged: ['handleBallotMetaChanged'],
+   RangeChanged: ['handleBallotRangeChanged'],
+   RCVChanged: ['handleBallotRcvChanged'],
+   Removed: ['handleBallotRemoved'],
+   VoteCast: ['handleBallotVoteCast'],
  },
```

Three remain `[]` deliberately — chain configuration with no entity. Comment them so the sync-metadata "registered, not handled" report ([09](./09-infrastructure.md)) does not re-flag them.

---

## Tests

- **Unit:** each of the 15 handled events, fixture-based per supported spec range.
- **Unit:** `ScheduleCreated` at spec < 6_000_000 decodes 3 args and recovers `scheduleId` from the nested `StoredSchedule.id`; at ≥ 6_000_000 decodes 4 args from `params[2]`. Arity mismatch throws. **The regression test for the only positional change in this domain.**
- **Unit:** a pre-v6 schedule populates `period`/`remaining` and leaves `pendingCheckpoints` null; a v6+ schedule does the reverse.
- **Unit:** a CA with `targetTreatment: Exclude` and a `didWithholdingTax` override round-trips.
- **Integration:** every `Distribution` links to a `CorporateAction`.
- **Integration:** for a distribution with a record date, the linked `Checkpoint.totalSupply` is non-zero and `datetime` precedes the payment.
- **Integration:** `DistributionPayment.tax` is reconcilable against the CA's default rate or the per-DID override — the check that is impossible today.

---

## Consumer impact

| Consumer | Query | Impact |
|---|---|---|
| SDK | `distributions`, `distributionPayments` | **Additive** — new `corporateAction`/`checkpoint` relations. Existing fields unchanged. |
| Portal | `distributionPayments` | Same; no change required. |
| Both | `CorporateAction`, `Checkpoint`, `CorporateBallot` | New. Nothing to break. |

Purely additive despite being the largest coverage addition. That makes it a good candidate to land independently of the breaking model changes — it does not need to wait for [02](./02-polyx-ledger.md) or [03](./03-holdings-nfts.md).
