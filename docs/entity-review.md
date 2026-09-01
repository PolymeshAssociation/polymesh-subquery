# Entity-by-Entity Review

Part of the [indexer review](./README.md).
All **69** entities in `schema.graphql`, grouped by domain, each judged against the use cases it exists to serve.

> **Revision 2026-09-01.** Re-based on `alpha@0f4f337`. Two entities added by PR #342 (`EvmTransaction`, `EvmAccountMapping`), the infrastructure verdicts corrected, and four new findings folded in. See [`CHANGES.md`](./CHANGES.md).

Verdict key: **✅ fit for purpose** · **⚠️ partial — works but has a named limitation** · **❌ gap — cannot answer its core question** · **🚫 missing — no entity exists for a domain the chain emits**

**[V]** verified against chain source or code. **[I]** inference.

Domains already covered in depth elsewhere are summarised here with a pointer: [`polyx-balance-model.md`](./reference/polyx-balance-model.md), [`identity-asset-model.md`](./reference/identity-asset-model.md), [`defect-log.md`](./reference/defect-log.md).

---

## Handler coverage by pallet **[V]**

Derived from `project.ts` (`handled` = has ≥1 handler, `empty` = registered as `[]`):

| Pallet | Handled | Empty | Pallet | Handled | Empty |
|---|---|---|---|---|---|
| identity | 19 | 3 | asset | 22 | 18 |
| settlement | 22 | 7 | staking | 8 | **24** |
| multiSig | 16 | 4 | pips | 4 | **16** |
| balances | 18 | 6 | bridge | 1 | **16** |
| confidentialAssets | 19 | 7 | portfolio | 6 | 5 |
| statistics | 9 | 1 | **corporateAction** | **0** | **8** |
| complianceManager | 8 | 1 | **corporateBallot** | **0** | **6** |
| externalAgents | 5 | 0 | **checkpoint** | **0** | **4** |
| capitalDistribution | 4 | 0 | sto | 7 | 0 |
| nft | 3 | 0 | validators | 1 | 6 |

Three pallets have **zero** handled events. Two of them (`checkpoint`, `corporateBallot`) have **no entity at all**.

`relayer` is absent from this table entirely — it is in `ModuleIdEnum` and `CallIdEnum` but has no `project.ts` entry and no entity **[V]**, so it is a fourth uncovered pallet that the coverage table cannot show. See §15.

---

## 1. Infrastructure

| Entity | Verdict | Notes |
|---|---|---|
| `Block` | ⚠️ | Complete as a record, but **written from `handleEvent`, not a block handler** **[V]** — a block with no handled event gets no row. The table is sparse and `MAX(block_id)` is not a freshness signal; `_metadata.lastProcessedHeight` is. Belongs in the docstring (defect B9). Carries `specVersionId` — the hook a `ChainUpgrade` entity would build on. |
| `Extrinsic` | ⚠️ | Indexes on `moduleId`, `callId`, `address` and `signed` **do exist** — in `db/compat.sql`, not `schema.graphql` **[V]**. The defect is the split source of truth, not the absence. `architecture-review.md` §4.1. |
| `Event` | ⚠️ | Largest table. Indexes on `moduleId`, `eventId`, the composite, and `left(event_arg_N, 100)` all exist in `compat.sql` **[V]**, along with a generated `attributes JSONB` column — so the "`attributesTxt` → `jsonb`" recommendation is already implemented there. Same split-source-of-truth problem. |
| `EvmTransaction` | ✅ | New in PR #342. Full decoded Ethereum transaction — calldata, gas fields, revert state — keyed to its `Extrinsic`. Well documented in the schema; follows the settlement domain's conventions. |
| `EvmAccountMapping` | ✅ | New in PR #342. H160 ↔ `AccountId32`, from `revive.mapAccount` and genesis config. `mapped: Boolean!` correctly *not* indexed, consistent with the Boolean-index constraint (§8b). |
| `SubqueryVersion`, `Migration` | ✅ | Operational bookkeeping, fit for purpose. |
| `Debug`, `FoundType` | ⚠️ | Development instrumentation living in the production schema. |
| 🚫 `IndexOrigin` | 🚫 | **Missing.** Nothing records whether this index started at genesis, so a partial index is indistinguishable from a complete one and every accumulated total is a trap. Plan [10](./implementation/10-partial-index.md). |

> **Correction, 2026-09-01.** The `Extrinsic` and `Event` verdicts above previously read "no index on any filter column". That was true of `schema.graphql` and false of the deployed database — `db/compat.sql` creates 30 indexes including everything named **[V]**. `architecture-review.md` §4.1 carried the correction; this table did not, so the two documents disagreed. They now agree: the finding is **two sources of truth**, not missing indexes.

---

## 2. Identity & keys

Covered in `reference/identity-asset-model.md` Part 1. Summary:

| Entity | Verdict | Core issue |
|---|---|---|
| `Identity` | ❌ | `secondaryAccounts` **includes the primary account** **[V]**; `primaryAccount` is a `String`, not a relation. |
| `Account` | ⚠️ | No `role` discriminator, so the primary key is indistinguishable from secondaries. |
| `AccountHistory` | ❌ | Untyped `String` columns, no validity interval — cannot answer "who was primary at block N" as a listable/countable query. |
| `Permissions` + `PermissionsJson` | ⚠️ | Same shape defined twice; permission changes are not first-class history. |
| `ChildIdentity` | ❌ | Backing feature **removed at v8** **[V]**; rows persist forever with no unlink event. |
| `Authorization` | ⚠️ | `AuthorizationRetryLimitReached` unhandled, so exhausted authorizations look merely pending. |

---

## 3. MultiSig

| Entity | Verdict | Notes |
|---|---|---|
| `MultiSig` | ⚠️ | `address: String!` with **no relation to `Account`** — a multisig *is* an account holding POLYX and assets, but the two cannot be joined. |
| `MultiSigAdmin` | ⚠️ | `identityId: String!` while sibling `MultiSig.creator` is a relation. Inconsistent. |
| `MultiSigSigner` | ✅ | Polymorphic `signerType`/`signerValue` is a legitimate choice for an Account-or-Identity signer. |
| `MultiSigProposal`, `MultiSigProposalVote` | ✅ | Well modelled; status enum plus vote records. |

Best-covered pallet after settlement (16/20). The gap is relational, not behavioural.

---

## 4. Claims

| Entity | Verdict | Notes |
|---|---|---|
| `Claim` | ❌ | **Identity collides across issuers** — see below. |
| `ClaimScope` | ⚠️ | Overlaps `Claim.scope` (a jsonField). Two representations of scope. |
| `CustomClaimType` | ✅ | Fine. |
| `TrustedClaimIssuer` | ⚠️ | `issuer: String!` not a relation, while `Claim.issuer: Identity!` is. |

### Claim id omits the issuer **[V]**

[`mapClaim.ts:43-61`](../src/mappings/entities/identities/mapClaim.ts#L43) builds the id from `[target, claimType]` plus optional `customClaimTypeId`, `scope`, `jurisdiction`, `cddId`. **`issuer` is not part of it**, and `handleClaimAdded` calls `Claim.create({ id })`, which overwrites.

So if two trusted issuers both attest the same claim type over the same scope for the same target, they share one row and the second overwrites the first. `Claim.issuer` then reflects only whichever landed last.

This matters because Polymesh compliance is explicitly multi-issuer — `TrustedClaimIssuer` exists precisely so an asset can trust specific issuers. *"Does target T hold an Accredited claim from issuer X?"* is the core compliance question, and the model cannot represent two issuers' claims at once.

Secondary consequence: revocation sets `revokeDate` in place, and a later re-issue overwrites the row, so revoke → re-issue cycles leave no history. **[I]** Real-world frequency of both cases should be measured before sizing the fix.

---

## 5. Compliance & transfer restrictions

| Entity | Verdict | Notes |
|---|---|---|
| `Compliance` | ✅ | Requirements per asset. |
| `TransferManager` | ⚠️ | Explicitly "deprecated in favor of `TransferCompliance`", still written unconditionally alongside it. Dual model for one concept. |
| `StatType`, `TransferCompliance`, `TransferComplianceExemption` | ✅ | The current model; correctly version-gated. |

Consolidation candidate — see `architecture-review.md` §4.2.

---

## 6. Assets & holdings

Covered in `reference/identity-asset-model.md` Part 2. Summary:

| Entity | Verdict | Core issue |
|---|---|---|
| `Asset` | ⚠️ | Stale `# ticker` id comment; legacy `isUniquenessRequired`; no `holderCount`. |
| `AssetHolder` | ❌ | Identity-level only. **No portfolio-level holding entity exists at all** **[V]**. |
| `NftHolder` | ❌ | Identity-level, ids in an `[Int]` array. **No per-NFT entity** — individual tokens are unaddressable. |
| `AssetTransaction` | ⚠️ | Good movement log; missing the intra-identity movements held in `PortfolioMovement` (Francis's *One Movement Ledger*). |
| `AssetDocument`, `Funding`, `AssetMandatoryMediator`, `AssetPreApproval`, `TickerReservation` | ✅ | Fit for purpose. |
| 🚫 `AssetMetadata` | 🚫 | **Missing.** All ten metadata events registered `[]` **[V]**. |
| 🚫 `AssetAllowance` | 🚫 | **Missing.** v8 `Approval` / `AllowanceSpent` are not in `project.ts` at all **[V]**. |

---

## 7. Portfolios

| Entity | Verdict | Notes |
|---|---|---|
| `Portfolio` | ❌ | A label with a custodian. **No `holdings` field and no portfolio-keyed balance entity anywhere** — the portfolio's contents are unknowable without replaying every movement. |
| `PortfolioMovement` | ⚠️ | Correct as a log; near-duplicate of `AssetTransaction` and proposed for merge. |

Unhandled portfolio events **[V]**: `PreApprovedPortfolio`, `RevokePreApprovedPortfolio`, `AllowIdentityToCreatePortfolios`, `RevokeCreatePortfoliosPermission`, `UserPortfolios` — all `[]`. Note the asymmetry: asset-level pre-approval **is** modelled (`AssetPreApproval`), the portfolio-level equivalent is dropped.

---

## 8. Settlements — the internal reference standard

| Entity | Verdict | Notes |
|---|---|---|
| `Venue` | ✅ | |
| `Instruction` | ✅ | Status, type, dates, memo, mediators, `failureReason: ErrorJson`. |
| `Leg` | ✅ | Fungible / NonFungible / OffChain typed. |
| `InstructionParty` | ✅ | `identity: String!` is a *documented* choice — off-chain legs may have no DID. |
| `InstructionAffirmation` | ✅ | Mediator and off-chain cases handled explicitly, with expiry. |
| `InstructionEvent` | ✅ | **A first-class lifecycle table** — the pattern every other domain lacks. |
| `OffChainReceipt` | ✅ | |

This is the best-modelled domain in the schema: an explicit lifecycle event table, typed error capture, party/affirmation separation, and denormalisation choices documented in the schema rather than implied. **It should be the internal template for the other domains.**

Minor: `InstructionParty.portfolios: [Int]` is an array of numbers, not relations, so portfolio joins aren't possible from a party.

**One real defect, added 2026-09-01 (A14).** `Instruction.id` is the chain's own numeric sequence stored as a `String` **[V]**, so `orderBy: [ID_DESC]` sorts it lexicographically — `9999` ranks above `14712`. The list is ordered, stable, pages correctly, and puts the newest settlement about a hundred and ninety pages in. Nothing surfaces it. Fixed by D12 (zero-pad chain-assigned numeric ids); the interim workaround for a consumer is to order on `createdEventId`, which is padded on both halves and equivalent to id order.

The same shape applies to any chain-assigned numeric identifier stored as text, so it is worth sweeping the schema for others rather than fixing `Instruction` alone.

---

## 9. Corporate actions — half a domain

| Entity | Verdict | Notes |
|---|---|---|
| `Distribution` | ⚠️ | Exists and is fed (`capitalDistribution` 4/4 handled). |
| `DistributionPayment` | ⚠️ | Same. |
| 🚫 `CorporateAction` | 🚫 | **Missing** — `corporateAction` pallet is **0/8 handled** **[V]**. |
| 🚫 `Checkpoint` | 🚫 | **Missing** — `checkpoint` pallet is **0/4 handled** **[V]**. |
| 🚫 `CorporateBallot` | 🚫 | **Missing** — `corporateBallot` pallet is **0/6 handled** **[V]**. |

This is the largest structural hole after portfolio holdings. Distributions are recorded, but the corporate action that *defines* them is not: `CAInitiated`, `CARemoved`, `RecordDateChanged`, `DefaultTargetIdentitiesChanged`, `DefaultWithholdingTaxChanged`, `DidWithholdingTaxChanged`, `CALinkedToDoc` are all unhandled.

Consequences:
- **Record date is unknown**, so entitlement cannot be reconstructed or audited.
- **Withholding tax rates are unknown**, both default and per-DID — yet `DistributionPayment` records a `tax` amount whose basis is unindexed.
- **Target identities are unknown** — who a CA applied to cannot be answered.
- **Checkpoints are absent**, and a checkpoint is exactly the balance-at-record-date snapshot that makes a distribution verifiable.
- **Shareholder ballots are entirely unindexed** — a whole governance surface (`VoteCast` included) missing.

For a securities chain, corporate actions and checkpoints are core domain objects, not peripheral ones.

---

## 10. STO / fundraising

| Entity | Verdict | Notes |
|---|---|---|
| `Sto` | ✅ | Complete; `raisingAssetId: String!` deliberately non-relational and documented. `sto` pallet is 7/7 handled. |
| `Investment` | ⚠️ | `investor: Identity!` is a relation but `offeringAssetId: String!` is not — inconsistent. Overlaps `AssetTransaction` for the same movement. |

---

## 11. Governance / PIPs

| Entity | Verdict | Notes |
|---|---|---|
| `Proposal` | ⚠️ | Core fields present, but the lifecycle around them is not indexed (below). |
| `ProposalVote` | ⚠️ | `account: String!` not a relation; no link to the voting Identity. |
| 🚫 `PipSnapshot` | 🚫 | `snapshotted: Boolean!` is a flag; there is no snapshot entity, so snapshot membership and results are not queryable. |

`pips` is **4/20 handled** **[V]**. Unhandled and consequential:

- `ExecutionScheduled` / `ExpiryScheduled` — **when a passed PIP will take effect is unknown.** For governance this is arguably the most important fact about a proposal.
- `ProposalRefund` — the deposit refund. `Proposal.balance` therefore stays stale after close.
- `PipClosed`, `PipSkipped` — closure reason and skip count lost.
- `SnapshotResultsEnacted`, `SnapshotCleared` — snapshot outcomes lost.
- `HistoricalPipsPruned` — pruning unrecorded, so the index may diverge from chain state silently.

Also connects to the balance model: PIP voting locks POLYX under `PIPS_LOCK_ID` **[V]**, and those locks are unmodelled (`reference/polyx-balance-model.md` §1.2).

---

## 12. External agents

| Entity | Verdict | Notes |
|---|---|---|
| `TickerExternalAgent` | ⚠️ | Current agents only. `Ticker`-prefixed naming stale post-7.x. |
| `TickerExternalAgentAction` | ⚠️ | Action log. |
| `TickerExternalAgentHistory` | ⚠️ | `type: String!` is **untyped** (should be an enum) and `permissions: String` is **JSON-in-a-string** (should be the existing `PermissionsJson`). |
| `AgentGroup` | ❌ | **No `asset` relation** — id is `assetId/group_id` but there is no `asset: Asset!` field, so "all agent groups for asset X" requires parsing the id string. |
| `AgentGroupMembership` | ⚠️ | `member: String!` not an `Identity` relation. |

Three entities for one concept (agent membership + history) — merge candidate per `architecture-review.md` §4.2.

---

## 13. POLYX, staking, bridge

| Entity | Verdict | Notes |
|---|---|---|
| `PolyxTransaction` | ❌ | `BalanceTypeEnum` conflates pools, lock-floors and staking-ledger states; v8 `reserved` entirely unindexed. See `reference/polyx-balance-model.md`. |
| `StakingEvent` | ❌ | A log, not a position — and for pre-v8 rewards, an *incomplete* log. `rewardDestination` is `'LegacyUnknown'` for every pre-8.x `Reward`/`Rewarded` **[V]**, because the event carried only the stash. The v8 path correctly decodes the `RewardDestination` variant and resolves the account. **No `StakingPosition` / nomination entity** — current bonded amount, nominations, and validator prefs are not queryable. `staking` is **8/32 handled**; `Nominated` is handled but `Chilled`, `Kicked`, `PayoutStarted`, `EraPaid`, `ValidatorPrefsSet`, `StakersElected` are not. |
| `BridgeEvent` | ⚠️ | Only `Bridged` handled of 17 events. `BridgeTxScheduled`, `BridgeTxFailed`, `BridgeLimitUpdated`, `ControllerChanged`, `AdminChanged` unhandled — so bridge failures and configuration changes are invisible. Also hardcodes `/ 1_000_000` with integer division. |

🚫 **Missing: `StakingPosition`, `Nomination`, `Validator`, `Era`.** Staking is recorded purely as an event stream, so *"how much is this account staking right now, and with whom"* requires replaying all events.

### These rows are used for accounting, and that raises the bar **[V]**

`PolyxTransaction` and `StakingEvent` are the closest thing the index has to a general ledger, and they are read as one. That makes coverage gaps here different in kind from coverage gaps elsewhere: a missing corporate-action entity leaves a capability absent, while a missing reward destination leaves a **number that looks complete and is not**.

Two known cases, one verified and one not:

- **Pre-v8 reward destination is unrecoverable from the event** (A15, verified). Recoverable from `staking.payee(stash)` at the reward block — chain storage, no archive of anything but state required. Unmeasured: how often the payee differs from the stash.
- **Transaction-fee attribution across runtime versions** (not verified). Splitting a fee between validator, treasury and payer was derived rather than emitted on older runtimes, so the fee rows may not account for the whole fee at every spec version. Listed as an open question, not a finding.

The design consequence is D11: for this domain, correctness is **verified against chain state** rather than asserted from event coverage. The reconciliation harness in plan [02](./implementation/02-polyx-ledger.md) is the acceptance test, not a follow-up.

---

## 14. Confidential assets

| Entity | Verdict |
|---|---|
| `ConfidentialAccount`, `ConfidentialEncryptionKey`, `ConfidentialAsset`, `ConfidentialAccountAsset`, `ConfidentialSettlement`, `ConfidentialLeg`, `ConfidentialLegAffirmation`, `ConfidentialCurveTreeLeaf` | ✅ |

Newest domain (19/26 handled), modelled with the settlement domain's structure — legs, affirmations, explicit status enums. No legacy shape concerns. Nothing to flag beyond ordinary coverage gaps.

---

## 15. Relayer / subsidies — a whole pallet with no entity

| Entity | Verdict | Notes |
|---|---|---|
| 🚫 `Subsidy` | 🚫 | **Missing.** |
| 🚫 `Relayer` | 🚫 | **Missing.** |

The `relayer` pallet exists in `ModuleIdEnum`, and `approve_subsidy` / `revoke_subsidy` / `accept_subsidy` / `remove_subsidy` are in `CallIdEnum` **[V]** — so the enums assert coverage that does not exist, the same pattern §12's closing observation describes. `project.ts` registers no relayer handler at all.

A subsidy lets one key pay another's fees, which is a standing financial relationship between two identities. Its history — granted when, by whom, for how much, revoked when — is exactly the shape this index is good at, and it is entirely absent.

Smallest of the remaining pallet-shaped gaps and the cheapest to close: one entity plus a paying-key/beneficiary relation, no version branching, and it is purely additive.

---

## Summary — what does not serve its use case

**Cannot answer their core question (❌):**

1. `Portfolio` / `AssetHolder` / `NftHolder` — portfolio-level holdings unknowable; individual NFTs unaddressable.
2. `Claim` — cannot represent the same claim from two issuers.
3. `Identity` / `AccountHistory` — key history not listable; `secondaryAccounts` returns the primary too.
4. `ChildIdentity` — stale rows for a removed feature.
5. `PolyxTransaction` — balance buckets not derivable.
6. `AgentGroup` — cannot be queried by asset.
7. `StakingEvent` — pre-v8 rewards cannot say which account received them (A15).

**Missing entirely (🚫):** `CorporateAction`, `Checkpoint`, `CorporateBallot`, `AssetMetadata`, `AssetAllowance`, `StakingPosition`/`Nomination`/`Validator`, `PipSnapshot`, `Subsidy`/`Relayer`, plus the `IndexerAnomaly` / `ChainUpgrade` / `IndexOrigin` operational entities proposed earlier.

**Priority by domain impact — [I], for team discussion:**

1. **Portfolio holdings + per-NFT** — most-requested capability, largest gap. Also the fix for the slowest blocks (`architecture-review.md` §13).
2. **Corporate actions, checkpoints and ballots** — core securities domain, 0/18 handled across three pallets. **In scope but low priority (D6)**: it is purely additive, so unlike the items above it makes nothing *wrong* today — it only leaves a capability absent.
3. **POLYX balance model** — correctness, not just coverage, and now with a verification requirement attached (D11).
4. **Claim issuer collision** — silent data loss in compliance-critical data.
5. **Staking positions** — event stream without state, plus the pre-v8 attribution gap.
6. **PIP lifecycle** — enactment timing unknown.
7. **Subsidies** — smallest remaining pallet-shaped gap, cheapest to close.

## Three structural observations

**Settlement is the template.** It is the only domain with a first-class lifecycle event table (`InstructionEvent`), typed error capture, and denormalisation choices documented in the schema. Every gap above is a place where a domain lacks one of those three things. Adopting the settlement pattern domain-by-domain would be a coherent programme rather than a list of fixes.

**A registered event with no handler is invisible in review.** `project.ts` lists ~150 events as `[]`, and `schema.graphql`'s `EventIdEnum` implies coverage that does not exist. Nothing surfaces the difference. The metadata-sync script (`architecture-review.md` §3) should emit an "in enum, registered, not handled" report — it is the cheapest way to stop this list regrowing. The `relayer` pallet (§15) is the clearest case: its calls are in `CallIdEnum` and it has no handler and no entity.

**An id that will be sorted must sort correctly.** Three findings turn out to be one — the padded composite id (D4), `getPaginatedData` ordering by its filter column (A13), and `Instruction.id` sorting lexicographically (A14). Each produces a list that is ordered, stable, paged, and wrong, with nothing to indicate it. This is a schema-review rule rather than a domain: *if a column is going to be sorted, its sort order must agree with its meaning.* `architecture-review.md` §9 states it once.
