# Consumer Query Analysis

What the two direct GraphQL consumers actually query, and what that evidence settles.

**Sources analysed [V]** — verified against the authoritative upstream branches after fetching, not local checkouts:
- `polymesh-sdk` → **`origin/develop`**, `src/middleware/queries/*.ts` (13 modules)
- `polymesh-portal` → **`origin/main`**, `src/helpers/graphqlQueries.ts`
- `polymesh-rest-api` → **no direct GraphQL**; it consumes the SDK, so it inherits the SDK's surface.

**Caveat:** these are the consumers present locally. External or internal consumers querying the endpoint directly would not appear here, so "not queried by SDK or portal" means *unobserved*, not *unused*. Confirm before treating anything as dead.

> **Revision note.** A first pass read local working copies and compared the SDK against `origin/master` (which trails `develop`). Re-running against the correct branches changed two things: the portal's surface is **5** connections, not 6 (`extrinsics` was dropped), and its `paddedIds` compatibility flag has been **removed**. Everything else — the `OR` evidence, portfolio grain, `groupedAggregates`, the claims issuer filter — was confirmed unchanged on the correct branches. See §7.

---

## 1. Consumption map

**SDK — 27 entity connections** (plus `groupedAggregates`):

`assetHolders` · `assetTransactions` · `assets` · `authorizations` · `blocks` · `claims` · `customClaimTypes` · `distributionPayments` · `distributions` · `events` · `extrinsics` · `instructionAffirmations` · `instructionEvents` · `instructions` · `investments` · `legs` · `multiSigProposalVotes` · `multiSigProposals` · `nftHolders` · `polyxTransactions` · `portfolioMovements` · `portfolios` · `subqueryVersions` · `tickerExternalAgentActions` · `tickerExternalAgentHistories` · `tickerExternalAgents` · `trustedClaimIssuers`

**Portal — 5 connections** (`origin/main`):

`assetTransactions` · `distributionPayments` · `multiSigProposals` · `portfolioMovements` · `stakingEvents`

**Union: 28 of 67 entities are observably queried** — the portal's five are a subset of the SDK's surface except `stakingEvents`.

Notably absent from both: `Identity` and `Account` have **no root query field** in either consumer — identity data is reached through relations on other entities, never queried directly.

---

## 2. What the evidence settles

### 2.1 The `OR`-across-from/to pattern is real, and it is everywhere **[V]**

`polyx-balance-model.md` §7.1 argued for an entry-centric ledger on the grounds that movement-centric storage forces an awkward `OR`. That was inference. It is now confirmed three times over in production code.

**SDK, `polyxTransactions.ts:41-46`** — the primary POLYX query:

```js
filter: { or: [ { identityId: …, address: … }, { toId: …, toAddress: … } ] }
```

**Portal, `graphqlQueries.ts:22-39`** — `assetTransactions`, with *three* different OR-pairs depending on grain:

```js
or: [ { fromAccount:   {equalTo: …} }, { toAccount:   {equalTo: …} } ]   // account grain
or: [ { fromPortfolioId:{equalTo: …} }, { toPortfolioId:{equalTo: …} } ] // portfolio grain
or: [ { fromIdentityId:{equalTo: …} }, { toIdentityId:{equalTo: …} } ]   // identity grain
```

**Subscan** — the `Transfers (231)` vs `Extrinsics (116)` split (§6 of the balance doc) is the same shape.

Every consumer that asks "show me this holder's movements" pays for an OR across two indexed columns. The entry-centric design turns all of these into a single indexed `accountId` / `holderId` lookup. **This is the strongest-evidenced change in the whole review.**

### 2.2 The portal already demands portfolio-grain movement **[V]**

The middle branch above filters `fromPortfolioId` / `toPortfolioId`. So portfolio grain is not a hypothetical requirement — it is live in production, and it is served today only by the *movement log*, never by a balance. `identity-asset-model.md` G8 (no portfolio-level holding entity) is therefore a gap against a real, current consumer need, not a speculative one.

### 2.3 `groupedAggregates` is already in production **[V]**

`claims.ts:96` — `claimsGroupingQuery`:

```graphql
claims(filter: …) { groupedAggregates(groupBy: [TARGET_ID], having: {}) { keys } }
```

pg-aggregates is not a proposal; it is a dependency. This confirms `polyx-balance-model.md` Part 8's premise, and means the "every groupable dimension must be a materialised column" rule already binds today.

### 2.4 jsonField filtering is used

`claims.ts:35` — `scope: { contains: $scope }`. jsonFields are not opaque to consumers; Postgraphile containment filters work. This makes the `lifetimeByKind` / `locks` / `holds` jsonField proposals more viable than I credited them, though grouping still requires real columns.

### 2.5 `filterExpiry` is a consumer-driven denormalisation

`claims.ts:38-40` filters `filterExpiry: { greaterThan: $expiryTimestamp }` alongside a null check on `expiry`. The odd duplicate column exists to make expiry filtering possible — worth preserving deliberately in any redesign rather than "cleaning up".

---

## 3. Escalation: the Claim issuer collision is a live compliance bug **[V]**

`../entity-review.md` §4 recorded that `Claim`'s id omits `issuer` ([`mapClaim.ts:43-61`](../../src/mappings/entities/identities/mapClaim.ts#L43)). The SDK's query makes the consequence concrete.

`createClaimsFilters` (`claims.ts:22-50`) builds:

```js
filters = ['revokeDate: { isNull: true }']
filters.push('targetId: { in: $dids }')
filters.push('issuerId: { in: $trustedClaimIssuers }')   // ← filters by issuer
filters.push('scope: { contains: $scope }')
filters.push('type: { in: $claimTypes }')
```

The index stores **one row** per `(target, type, scope)`; the SDK queries **by issuer**. Two failure modes follow, both silent:

**Lost claim.** Issuer A and issuer B both attest `Accredited` for target T over scope S. Both write the same id; B overwrites A, leaving `issuerId = B`. An SDK compliance check with `trustedClaimIssuers: [A]` matches nothing — **T is treated as not accredited despite holding a valid claim from A.**

**Spurious revocation.** B later revokes. `handleClaimRevoked` sets `revokeDate` on the shared row. The default filter `revokeDate: { isNull: true }` now excludes it — so **A's still-valid claim disappears from every claims query.**

Both directions produce wrong compliance answers with no error anywhere. This should move to the top of the defect list: it is the only finding so far that silently returns incorrect results to a compliance code path.

**[I]** Frequency depends on how often multiple trusted issuers attest the same claim type and scope for one target. A count query would size it — but the correctness argument does not depend on the frequency.

---

## 4. Entities unobserved by either consumer

Roughly 39 of 67 entities are not queried by the SDK or portal. Grouped by what that likely means:

| Group | Entities | Read |
|---|---|---|
| **Reached via relations only** | `Identity`, `Account`, `Permissions`, `Venue`, `InstructionParty`, `OffChainReceipt`, `Sto`, `AssetDocument` | Used, but never as a root query — relation traversal only. Safe to restructure as long as relations survive. |
| **Compliance set** | `Compliance`, `TransferManager`, `StatType`, `TransferCompliance`, `TransferComplianceExemption`, `ClaimScope` | Read from chain by the SDK rather than the index. Confirms `TransferManager`/`TransferCompliance` consolidation is low-risk. |
| **Governance** | `Proposal`, `ProposalVote` | Unobserved. Lowers the priority of the PIP lifecycle gaps — worth confirming nothing external depends on them. |
| **Identity extras** | `AccountHistory`, `ChildIdentity`, `MultiSig`, `MultiSigAdmin`, `MultiSigSigner`, `AgentGroup`, `AgentGroupMembership` | Unobserved. `IdentityKey` replacing `AccountHistory` becomes near-zero-risk. |
| **Confidential (8)** | all `Confidential*` | Newest domain; consumers likely not built yet. |
| **Other** | `BridgeEvent`, `Funding`, `AssetMandatoryMediator`, `AssetPreApproval`, `TickerReservation`, `Migration`, `Debug`, `FoundType` | Mixed; `Debug`/`FoundType` are dev instrumentation. |

**Do not delete anything on this basis alone** — it establishes *low observed risk*, not *no risk*. But it does mean the redesign has far more freedom than the entity count suggested.

---

## 5. What breaking-change freedom changes

With breaking changes accepted, the three-phase *additive → deprecate → remove* staging in `polyx-balance-model.md` §5, §7 and `identity-asset-model.md` §1.3 is **no longer required**. Those sections should be read as describing a constraint that has been lifted.

Direct consequences:

- `PolyxTransaction` can be **replaced** by `PolyxEntry` + `AccountBalance`, not shadowed by them.
- `PortfolioMovement` folds into the movement ledger in one step; no dual-write window.
- `BalanceTypeEnum` is replaced outright by `fromPool`/`toPool` rather than backfilled alongside `type`.
- `AccountHistory` → `IdentityKey` directly.
- `AssetHolder` / `NftHolder` become derived views or rollups over `Holding`; identity-grain is no longer the stored truth.
- `Identity.secondaryAccounts` gets correct semantics instead of a compatibility alias.

The two consumers will need coordinated updates. The SDK's 27 connections and the portal's 6 are a bounded, enumerable surface — this document is the checklist.

**What does *not* change:** every one of these still requires a genesis replay to produce correct history. Breaking-change freedom removes the *schema* constraint, not the *backfill* constraint. The reindex-budget question remains open and is now the main sequencing risk.

---

## 6. Recommended reprioritisation

Evidence from this analysis shifts the order proposed in `../entity-review.md`:

1. **Claim issuer collision** — promoted to first. Only known finding that silently returns wrong answers to a compliance path, and the SDK query proves it is reachable.
2. **Entry-centric movement ledger** (POLYX + assets) — three independent confirmations; fixes the most common query shape across both consumers.
3. **Portfolio-grain holdings** — confirmed live requirement via the portal's `fromPortfolioId`/`toPortfolioId` filter.
4. **POLYX balance correctness** (A1, A6, A9, A10) — `polyxTransactions` is a core SDK query.
5. **Corporate actions / checkpoints** — unchanged; `distributions` and `distributionPayments` *are* consumed by both, so the missing CA definitions sit directly beneath a live surface.
6. **Staking positions** — portal queries `stakingEvents` and filters `eventId: { in: [Reward, Rewarded] }`, i.e. it is reconstructing reward history from a raw event stream.
7. **PIP lifecycle** — demoted; unobserved by either consumer.

---

## 7. Padded ids are a hard consumer dependency **[V]**

Verified on `polymesh-sdk` `origin/develop`, `src/middleware/queries/polyxTransactions.ts:59-66`:

> `id` is the indexer's `<block number>/<event index>`, both zero padded, so it is unique and ordering it as a string orders by block and then by position within the block. Ordering by `createdBlockId` alone leaves transactions in the same block in no defined order, which makes pages repeat or skip entries

`polyxTransactionsQuery` therefore defaults to `orderBy: [PolyxTransactionsOrderBy.IdDesc]` — ordering on the padded composite id, deliberately, to fix a pagination bug where pages repeated or skipped rows.

The in-flight `origin/middleware-ordering` branch formalises this behind an `orderByClause` helper with the same default, so the SDK is moving **toward** the scheme.

On the portal side, `origin/main` has **removed** the `paddedIds` compatibility flag and hardcoded the padded ordering (`orderBy: CREATED_EVENT_ID_DESC` on `assetTransactions` and `distributionPayments`, `CREATED_BLOCK_ID_DESC` on `portfolioMovements`). What was a compatibility shim is now an unconditional dependency.

**Implications:**
- The `padId` scheme must be **preserved**, not retired. It is the correct solution to intra-block ordering, not a workaround.
- Every new paginated entity in this review (`PolyxEntry`, `Holding`, `IdentityKey`) needs a padded block-then-index composite id for the same reason — which also settles the deterministic sub-index question in `polyx-balance-model.md` §7.6 Q9: it is required, not optional.
- `@dbType(type: "Int")` cannot substitute: a numeric block id gives no ordering *within* a block, which is precisely the failure mode described above.

## 8. Consumers have dropped chain v7

`polymesh-portal` `origin/main` HEAD is `chore: migrate to SDK v31 and remove chain v7 support` **[V]**.

This does not reduce the indexer's obligation — it must still replay v7-era history correctly — but it does mean **consumer-facing** v7 compatibility shims are no longer needed at the query layer, and that the v7→v8 boundary work in this review is aligned with where consumers already are.
