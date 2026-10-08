# 14 — Consumer requests: Polymesh Portal v2

The Portal v2 team keeps a register of what it needs from this indexer
(`polymesh-portal-v2/docs/tooling/indexer.md`, IDs `G-IDX-01` to `G-IDX-11`, last reconciled
2026-10-01 against hosted `19.7.0`). This plan checks each request against
`redesign/12-review-fixes` and lists what is left. The last section lists gaps of the same kind
that this check turned up.

Status (2026-10-07): 14.1 and 14.2 are done, 14.3 is decided (no change), 14.4 is built and
awaits a full resync (step O), 14.5 is on hold, and 14.6 (locked amounts) is deferred.

## Summary

| ID | Ask | On the redesign | Left to decide or do |
|---|---|---|---|
| G-IDX-01 | `revive.ethTransact` attributed to its sender | ✅ forward fix; the history needs a reindex | nothing in code: the redesign's genesis reindex backfills it |
| G-IDX-07 | authorization payloads migrated to asset ids | ✅ forward fix and repair; the history needs a reindex | as G-IDX-01 |
| G-IDX-11 | 8.1.1's six events, holder freezes, NFT approvals | ✅ all six events handled, `Holding.frozen`/`frozenSince`, `NftApproval`/`NftOperatorApproval` | ✅ **14.1** the cast (`6c9ed9b`); ✅ **14.2** freezes in the agent action log (`93722d0`) |
| G-IDX-02 | ballots | ✅ `CorporateBallot`, `CorporateBallotVote` | — |
| G-IDX-03 | checkpoints and schedules | ✅ `Checkpoint`, `CheckpointSchedule` | — |
| G-IDX-04 | corporate actions | ✅ `CorporateAction`, `CorporateActionDefaultConfig` | — |
| G-IDX-08 | holdings per portfolio | ✅ `Holding`, portfolio and account grain | — |
| G-IDX-09 | numeric ids sort numerically | ✅ for `Instruction`, `Authorization`, `Venue`, `Proposal` | ✅ **14.3** decided: no change; consumers order by `createdEvent` |
| G-IDX-10 | staking history per operator per era | ✅ `ValidatorEra`, `Slash`, `Era.totalPoints` | **14.4** built (`701b642`, PR #365); awaiting step O |
| G-IDX-05 | subsidies | ✅ `Subsidy` | — |
| G-IDX-06 | allowances and their history | ✅ `AssetAllowance`; "what was it before" needs **14.5** | **14.5:** on hold (see §14.5) |

## Closed by the redesign

These need no work, but the Portal's register should change when the redesign ships:

- **G-IDX-01 and G-IDX-07 are fixed by the reindex.** The redesign can only be deployed by a genesis
  reindex (its schema is incompatible), so every `ethTransact` gets its sender
  (`mapExtrinsic.ts`, `resolveEthTransact`) and every authorization is written with the repaired
  payload (`repairAuthorizations.ts`), from block 0. No separate backfill is needed.
- **G-IDX-10's note on pre-v8 rewards is out of date.** `LegacyUnknown` is no longer what a
  pre-v8 reward records: the redesign reads `staking.payee` at the reward's block
  (`resolveLegacyRewardDestination`), and `LegacyUnknown` remains only for a runtime with no
  `staking.payee`. So pre-v8 nominator payouts can be attributed to the account that received them,
  and the Portal's bound on `P-STK-14` goes away.
- **G-IDX-08's `assetCount`** is a count query on `Holding` (`portfolio`, `amount > 0`), one round
  trip, with no new field.

## 14.1 The next-event cast that can halt the indexer

**Done** in `6c9ed9b` on PR 361. `processUpdateReason` labelled an instruction-less transfer with
the next event's name, cast unchecked to `EventIdEnum`, so a new event the enum lacked would fail
the Postgres enum insert and stop indexing for good. It now goes through `toEnum(…,
EventIdEnum.Unknown)`, as `alpha`'s `5c36f8b` does.

## 14.2 Freezes and forced transfers in the agent action log

**Done** in `93722d0` (PR #365). `AssetAgentAction` now records
`SetAccountFreeze`, `FrozenBalanceSet` and `ControllerTransferTo`, and also `TickerLinkedToAsset`
(listed but commented out since 7.x support was added) and `TickerUnlinkedFromAsset` (never
listed). Linking and unlinking a ticker require the agent's permission (`ensure_perms`) in every
runtime from v7.0. Each row has the caller and the asset; the holder and the amount stay on the
row's event.

**Freeze admins are not an asset feature.** `FreezeAdminAdded`/`FreezeAdminRemoved` belong to the
bridge pallet, removed in v7, and gate freezing the bridge, not assets. Asset freezes are an
ordinary agent permission, which the action log now covers. Nothing to index.

**Freeze state needs no schema change.** The chain (v8.1.2) has four kinds of asset freeze, and the
redesign holds the current state of each:

| Chain state | Set by | Indexed as |
|---|---|---|
| The whole asset (`Frozen`) | `AssetFrozen` / `AssetUnfrozen` | `Asset.isFrozen` |
| One holder entirely (`FrozenAccounts`, `FrozenPortfolios`) | `SetAccountFreeze { holder, freeze }` | `Holding.frozenSince`, null when not frozen |
| Part of one holder's balance (`FrozenBalance`, `PortfolioFrozenAssets`) | `FrozenBalanceSet { asset_holder, frozen_balance }`, the absolute amount | `Holding.frozen` |
| An identity's secondary keys | `SecondaryKeysFrozen` / `SecondaryKeysUnfrozen` | `Identity.secondaryKeysFrozen` |

A holder is an account or a portfolio, which is exactly a `Holding` row's grain, and freezing a
holder with no balance creates its row. So "which holders of this asset are frozen" is one
filtered query on `Holding`, and "who froze it, when" is the asset's agent actions. Two possible
additions, neither needed now:

- `Asset.frozenSince`, matching `Holding`'s; `isFrozen` alone does not say since when;
- a holder reference on `AssetAgentAction`, so one holder's freeze history is a filter rather
  than a read of each action's event. The per-asset list is short, so filtering it on the
  client is enough.

## 14.3 Ordering by id

**Decided: change nothing.** An id identifies a row, and listing in creation order is done
with `createdEvent` (zero-padded, so it sorts correctly and is a total order) or with the entity's
own number. The check:

| Entity | Id | A number to order by | Consumers ordering by id |
|---|---|---|---|
| `Instruction`, `Authorization`, `Venue`, `Proposal` | the chain's number, zero-padded (D12) | the id | the SDK orders instructions and authorizations by `createdEvent` |
| `Nft` | `assetId/` + padded token id | `nftId` | — |
| `Event`, `Extrinsic`, `AssetTransaction`, `Investment`, `DistributionPayment` | block and event position, padded | the id | the SDK uses `ID_ASC` here, which is chronological |
| `CorporateAction`, `Distribution`, `Checkpoint`, `CheckpointSchedule`, `AssetDocument`, `Sto`, `MultiSigProposal` | `assetId/number` | `localId`, `checkpointId`, `scheduleId`, `documentId`, `stoId`, `proposalId` | the SDK orders multisig proposals by `proposalId` |
| `CustomClaimType` | the chain's number, unpadded | none | the SDK orders by `createdBlock`, then id as a tie-break within one block |
| `CorporateBallot` | `assetId/localId` | none of its own; its `corporateAction.localId`, which is nullable | none found |
| `GlobalMetadataKey`, `CustomAssetType` | the chain's number, unpadded | none | none found |
| `AgentGroup`, `AssetMetadata` | compound, with the chain's number last | none | none found (the SDK reads both from chain) |
| `ConfidentialSettlement` | the chain's number, unpadded | none | none found; not on mainnet |

"Consumers" means the SDK's middleware queries, the REST API, Portal and Portal v2; none of them
query `GlobalMetadataKey`, `CustomAssetType`, `CorporateBallot`, `AgentGroup` or
`ConfidentialSettlement`. Of all these, only `CustomClaimType` is ordered by its id at all, and only
as a tie-break between claim types created in the same block.

`CorporateBallot` needs no `localId` of its own: its id is its corporate action's id
(`assetId/localId`), and the relation is null only when the index lacks the corporate action, which
a genesis sync does not.

**Rule for consumers:** list in creation order with `createdEvent`, or with the entity's own
number. An id is for lookups, padded or not. This is recorded in
`docs/reference/consumer-queries.md`.

## 14.4 Staking per validator per era (G-IDX-10)

**Built** in `701b642` (PR #365), awaiting validation by a full mainnet and testnet resync (step
O). This was plan [07](./07-staking.md)'s open scope
question, and the Portal's request (exposure, points, commission history, active-set membership
and slashes per operator per era) answered it.

### Schema

- **`ValidatorEra`** (`padId(eraIndex)/stash`): one row per validator per elected era, with
  `ownStake`, `totalStake`, `nominatorCount`, `commission` (Perbill parts, as
  `Validator.commission`), `blocked`, and `points` once the era is paid. A row exists exactly when
  the validator was elected, so an era's rows are its active set and a validator's rows are its
  history. Indexed by `eraIndex`, `identity` and `(validator, eraIndex)`.
- **`Era`** gains `validatorCount`, `totalPoints` and the derived `validators`.
- **`Slash`** (`blockEventId`): the slashed `account`, the offending `validator` (the account itself,
  or the validator it nominated), the `eraIndex` it was applied in, and the `amount`.

### Where the data comes from, as the chain code shows

| Question | Answer from the chain source |
|---|---|
| Which era do the exposures belong to when the election event fires? | `staking.currentEra`, the era being planned. Every runtime increments `CurrentEra` and stores the exposures and prefs for it in the same block as the event (v2.0–v7.4 `select_and_update_validators`/`trigger_new_era`; v8 `trigger_new_era` → `store_stakers_info`). `Era` already opened this way |
| Which storage holds the exposures? | v2.0–v7.4: `erasStakers` (whole exposure; `others` gives the nominator count) and `erasStakersClipped`. v8: `erasStakersOverview` (`own`, `total`, `nominatorCount`) and `erasStakersPaged`; `erasStakers` is no longer written |
| Commission and `blocked`? | `erasValidatorPrefs(era, stash)`, written with the exposures in every runtime |
| When are an era's points final? | `reward_by_ids` adds to the **active** era, and `end_era` (`EraPaid`/`EraPayout`) and `start_era` run in the same `rotate_session`. So in the block that pays era N, N is no longer active and its points are final |
| Can every slash be placed? | Mainnet and testnet defer slashes 14 eras (`SlashDeferDuration`), so each is applied from `staking.unappliedSlashes`, read at the parent block. Its shape (`validator`, `own`, `others`, `reporters`, `payout`) is the same before and from v8 |

The v8 sources are polkadot-sdk's `polymesh-v8-stable2603-4` (v8.0.2 on); v8.0.0 used `-2`.

### A bug this fixed

The elected set was read from `erasStakers` keys. v8 no longer writes that map, so every v8
election found nobody elected and marked every validator inactive. The set now comes from
whichever map the electing runtime wrote.

### Cost and size

A few map reads per era over the elected set, and one parent-block read per block that applies
slashes. Rows: validators × eras, in the tens to hundreds of thousands over the chain's life. Each
row is written once and updated once, and gives commission a history (§14.5) without historical
queries.

### Left out on purpose

- **Per-nominator exposure per era:** nominators × validators × eras, millions of rows, and not
  asked for. A nominator's rewards per era are already `StakingEvent` rows.
- **Offences** (`offences.Offence`): the slash says what happened to the stake. An `Offence`
  entity could follow if a screen needs the reason.

### The validator a reward came from

A reward's `StakingEvent` has its stash and its era, but not the validator whose payout paid it.
For a nominator that is the useful part: which validator earned it this reward. Whether it can be
recorded exactly depends on the runtime:

- **v7.0 on: exact, and cheap.** Every payout begins with `staking.PayoutStarted { era_index,
  validator_stash, … }`, and v8 emits one per page of a paged payout. The ledger already reads it
  for the era (`handlePayoutStarted`), so keeping `validator_stash` beside it and stamping a new
  `StakingEvent.validator` on each reward of that payout is a few lines. This is also where reward
  rows get their `eraIndex`.
- **Before v7: not exact.** There is no `PayoutStarted`, and `Reward(did, stash, amount)` names only
  the recipient and its own identity. A payout pays the validator first and then its nominators,
  and system payouts run back to back in one block with nothing between them. So the validator could
  only be inferred, from "the last reward to a stash elected in that era". The same gap means
  pre-v7 rewards have no `eraIndex` either.

**Done** in `006f796` (PR #365): `StakingEvent.validator` is recorded for v7 on, where it is exact,
and left null before v7, as `eraIndex` already is. Inferring the pre-v7 values would put a guess in
the data that looks like a fact. Mainnet entered v7 at block 15,988,306, so this covers the recent
history a nomination screen looks at most.

## 14.5 History of mutable state

Some requests are for history rather than current state: allowances ("what was it before it was
changed", G-IDX-06), the NFT approval trail and freeze history (G-IDX-11), and commission history
(G-IDX-10). Two are already covered:

- **Commission history** is `ValidatorEra.commission` (14.4).
- **Freeze history** is the asset's agent actions (14.2), with the holder and amount on each
  action's event.

That leaves **allowances** and **NFT approvals**. The current state is in mutable rows
(`AssetAllowance`, `NftApproval`), which keep only the latest value and the event that set it.

### Example: an allowance's history

The chain emits `asset.Approval { owner, spender, asset_id, amount }`, where `amount` is the new
allowance, and `asset.AllowanceSpent { owner, spender, asset_id, amount_spent, remaining_allowance }`.
Together they are the whole trail, each step already absolute.

**(a) Historical queries.** `--disable-historical=false` keeps every version of every row, and
GraphQL can read a row as of a height: `assetAllowances(blockHeight: "24000000", filter: …)`. That
answers "what was it at block N", but not "list its changes": GraphQL has no query for a row's
versions, so a trail would need the heights of the changes from somewhere else first.

**(b) A change log.** A new append-only entity, for example `AssetAllowanceChange { asset, owner,
spender, kind: Approved | Spent, amount, allowanceAfter, createdEvent }`, written by the two
handlers that already run. The trail is then one indexed, typed query:
`assetAllowanceChanges(filter: { ownerId: …, spenderId: …, assetId: … }, orderBy: CREATED_EVENT_ID_ASC)`.

**(c) The `Event` table, today, with no change.** Every event is stored with its first four
arguments as text columns, and `(moduleId, eventId)` is indexed:

```graphql
events(
  filter: {
    moduleId: { equalTo: asset }
    eventId: { in: [Approval, AllowanceSpent] }
    eventArg_0: { equalTo: "<owner>" }
    eventArg_2: { equalTo: "<asset id>" }
  }
  orderBy: ID_ASC
) {
  nodes { id eventId eventArg_1 attributesTxt block { datetime } }
}
```

| | (a) Historical | (b) Change log | (c) `Event` table |
|---|---|---|---|
| Gives a trail | no, one point per query | yes | yes |
| Typed, related fields | yes | yes | no: text arguments, parsed by the consumer |
| Indexed | yes | yes | by event type only; the argument filters scan those events |
| Cost | already paid, for every entity (see below) | one row per change, a new entity and handler code | none |
| Stable for consumers | yes | yes | tied to the argument encoding, which §9.10 may change |

### What historical mode is actually for

No consumer uses it for reads: the SDK, the REST API, Portal and Portal v2 never pass
`blockHeight`. But SubQuery only indexes **unfinalized** blocks while historical mode is on
(`NodeConfig.unfinalizedBlocks` is `historical !== false`), because it rewinds a reorg by its row
versions. Turning it off would make the indexer wait for finality at the head. So historical mode
stays, for that, and its index cost is plan 13's question. That answers plan 13 §13.4's open
question: consumers issue no historical queries, so the indexes that only serve them can go
(§13's options C and B).

### Recommendation

- **Allowances and NFT approvals: (c), no schema change now.** Approvals are v8-only and rare, so a
  query filtered by event type is cheap, and the trail needs no reconstruction because each event
  carries the absolute value. Document the query in `docs/reference/consumer-queries.md`.
- **Move to (b) per screen** if a screen needs filtering or sorting that text arguments cannot
  give, or once §9.10 settles the argument encoding and (c)'s output would change under it. Each
  log is small and append-only.
- **Keep historical mode for unfinalized blocks**, and decide §13.4's index trimming on the
  evidence above.

**Decided 2026-10-07: on hold.** Nothing changes for now. The likely path is §9.10 of plan
[09](./09-infrastructure.md), the proposed replacement of the event-argument encoding, which is
waiting on agreement from the SDK and portal maintainers. Its `EventReference` would let a consumer
find every event that names an account, identity or asset in any position, which makes (c) indexed
and typed without a change log per entity. Revisit 14.5 when §9.10 is decided.

## 14.6 Locked amounts — deferred

`Holding` records what is frozen but not what is locked. The chain locks a holder's assets while
they are committed elsewhere: a sender's affirmed settlement legs, an STO's unsold offering, and a
capital distribution's unpaid amount (`portfolio.portfolioLockedAssets`, and from v8
`asset.lockedBalance` for account holders). A consumer that wants what a holder can move today
needs `amount − frozen − locked`.

**Decided 2026-10-08: not indexed for now.** No consumer has asked for locks across holders or for
their history, and the SDK already reads a portfolio's current lock from chain. Revisit when a
screen needs it.

What it would take, so it need not be worked out again:

- **Lock changes emit no event** (`set_portfolio_locked_balance` writes silently), so `locked` follows
  the events that cause them:

  | Pallet | Locks | Unlocks |
  |---|---|---|
  | Settlement | `InstructionAffirmed`: the on-chain legs sent from the affirming holder | `AffirmationWithdrawn` (that holder's legs); `InstructionExecuted` and `InstructionRejected` (every locked leg). A failed execution changes nothing: v8 releases the locks and transfers inside one transaction, which rolls back |
  | STOs | `FundraiserCreated`: the offering amount | `Invested`: the amount sold; closing or stopping: the remainder |
  | Capital distributions | `Created`: the amount | `BenefitClaimed`, `Reclaimed`, `Removed` |

- **Re-read, rather than derive.** On each of those events, read the lock for the holders it touches
  (the index's `Leg`, `Sto` and `Distribution` rows say which). It costs one or two reads per event
  and is exact by construction. Deriving the amounts from the events instead saves the reads but has
  to get every runtime's rules right: receipts could settle an on-chain leg off-chain before v6,
  affirmation changed at v6, mediators arrived in v7, and NFTs lock by token, not by amount.
- **Schema:** `Holding.locked: BigInt!`, plus a locked-NFT count if NFT locks are wanted.
- **Validation:** compare against `portfolioLockedAssets` and `asset.lockedBalance`, as the dev
  server's asset check already does for frozen amounts.

## Not a gap

- **`blocks` is not a freshness signal:** use `_metadata.lastProcessedHeight`. This is unchanged on
  the redesign, and worth a line in `docs/reference/consumer-queries.md`.
