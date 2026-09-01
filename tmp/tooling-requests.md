# Tooling requests — open gaps in the SDK, REST API, indexer and extension

- **Status:** Living register. Opened 2026-08-21.
- **Owner:** Portal v2 team; each item names the team that closes it.
- **Related:** [parity-checklist.md](parity-checklist.md) · [charter](charter.md) · [ADR index](adr/README.md)

## What this is for

Portal v2 depends on four surfaces it does not own — the **SDK**, the **REST API**, the **SubQuery
indexer**, and the **browser extension**. Every gap we hit in those has, until now, been recorded
wherever we happened to find it: a paragraph in an ADR, a row in the parity checklist, a note in
`CLAUDE.md`. That is fine for one gap and useless for twenty.

This document is the single register. It exists separately from the parity checklist because the two
have different audiences and different lifecycles:

|  | Parity checklist | This document |
|---|---|---|
| Audience | Portal team | SDK / REST / indexer / extension teams |
| Lifecycle | closes at the v2.0 launch gate | items close independently, on other teams' schedules |
| Question it answers | "can a user still do X?" | "what should we ask for, and what is it costing us?" |

**Rule:** a new gap gets an ID here first. Other documents reference it by ID and do not restate the
detail. If you find yourself explaining a gap twice, one of the two places is wrong.

**Rule: prefer the upstream fix to the local workaround.** We have direct influence over all four
surfaces, so a fix is usually genuinely available — and a workaround in the Portal is permanent cost
that hides the requirement from the team who owns it. So:

- Raise the gap **before** coding around it, and write the ask in terms of the concrete use case and
  its measured cost. That is what makes it actionable rather than a wish.
- Where a workaround is unavoidable in the meantime, it is **temporary**: it cites its gap ID at the
  call site, and it is pinned by a test that **fails when the gap closes**, so the workaround gets
  deleted instead of quietly outliving its reason. `packages/chain/src/raw/index.ts` and the
  inverted assertion in `portfolios.contract.test.ts` are the pattern.

## Status vocabulary

| Status | Meaning |
|---|---|
| **Open** | Raised here, not yet taken to the owning team |
| **Requested** | Raised with the owning team; no commitment yet |
| **Agreed** | Owning team has accepted it |
| **In flight** | A PR or branch exists |
| **Released** | Shipped upstream, but **not in the deployment we read**. Added 2026-08-24 for `G-REST-04`: the fix merged and was tagged the same day, and the hosted REST the Portal calls still answers `Cannot GET` on the routes it adds. The distinction recurs for every REST and indexer gap — a merge is not something a running screen can depend on |
| **Closed** | Shipped in a version we can depend on |
| **Won't fix** | Declined, superseded, or **withdrawn** by us as not a gap — kept with the reason |

## Priority

**P1** blocks a parity row or a phase. **P2** costs real work we would otherwise not do. **P3** is
worth having, not worth waiting for.

---

## Summary

**24 open, 4 agreed, 2 in flight, 9 closed, 4 withdrawn or premise-wrong.** Closed and withdrawn
items are at the [bottom](#closed-and-withdrawn), not deleted.

**The SDK team validated every SDK-owned item against the runtime and the indexer, and published
their plan.** It is at `~/projects/polymesh-sdk/sdk-request-plan.md` — read it before re-raising
anything here. It changed the verdict on **five** of our entries, and in four of those we were the
ones who were wrong:

| | |
|---|---|
| `G-SDK-15` | Withdrawn — the chain forbids custody of a default portfolio |
| `G-SDK-22` | Premise wrong — no Asset can lack a name; `asset_name` is required, not an `Option` |
| `G-SDK-23` | Our closing claim was wrong — the SDK does *not* hold each transaction's weight |
| `G-SDK-14` | Our two asks were in the wrong order — the storage is keyed `(owner, spender, asset)` |
| `G-SDK-16` | Right symptom, wrong cause — `instanceof` across duplicate `bignumber.js` copies, 30 sites |

It also found **five defects we did not file** by reading the code our entries pointed at, and one
class we never reached: ten paginated indexer queries with no unique ordering, so paging could
repeat and skip rows. `docs/plans/sdk-31.1-beta.6.md` carries what any of that changes for us.

| ID | Owner | Pri | Status | Gap |
|---|---|---|---|---|
| [G-SDK-01](#g-sdk-01) | SDK | ~~P1~~ | **Closed** | `rebond` and `chill` shipped in SDK `31.1.0-beta.6` |
| [G-IDX-01](#g-idx-01) | Indexer | **P1** | Agreed | `revive.ethTransact` is indexed with `address: null` |
| [G-REST-04](#g-rest-04) | REST | P2 | Released | REST ran SDK ≤30 against a chain-v8 runtime — fixed in `v9.0.0-alpha.1`, which the hosted API has not taken |
| [G-SDK-02](#g-sdk-02) | SDK | ~~P2~~ | **Closed** | Era progress, constants and per-era reads shipped in `31.1.0-beta.6` |
| [G-SDK-05](#g-sdk-05) | **SDK core** | P2 | Open | Dual-format `@polkadot` load, originating in the SDK |
| [G-REST-01](#g-rest-01) | REST | P2 | Open | Zero staking endpoints |
| [G-REST-07](#g-rest-07) | REST | P2 | Open | An asset detail page costs five round trips |
| [G-IDX-02](#g-idx-02) | Indexer | P2 | Open | No `ballot` entity |
| [G-IDX-03](#g-idx-03) | Indexer | P2 | Open | No `checkpoint` / `checkpointSchedule` entities |
| [G-IDX-04](#g-idx-04) | Indexer | P2 | Open | No generic `corporateAction` entity |
| [G-SDK-03](#g-sdk-03) | SDK | ~~P3~~ | **Closed** | `withdraw` reads `slashingSpans` by stash — fixed and tested upstream |
| [G-REST-02](#g-rest-02) | REST | P3 | Open | No corporate-ballot endpoints |
| [G-REST-05](#g-rest-05) | REST | P3 | Open | No asset enumeration — indexer is the intended source |
| [G-REST-06](#g-rest-06) | REST | P3 | Open | A ticker resolves in the `{assetId}` position |
| [G-REST-08](#g-rest-08) | REST | P3 | Open | `developer-testing` cannot create identities on v8 |
| [G-REST-03](#g-rest-03) | REST | P3 | Open | Offerings are read-only |
| [G-IDX-05](#g-idx-05) | Indexer | P3 | Open | No `subsidy` / `relayer` entities |
| [G-SDK-04](#g-sdk-04) | SDK | P3 | Open | No `payoutStakers`, no validator-side operations |
| [G-SDK-12](#g-sdk-12) | SDK | P2 | **In flight** | `getHeldAssets` cannot ask for assets *currently* held — `getAssetHoldings({ heldNow })` in [PR #1662](https://github.com/PolymeshAssociation/polymesh-sdk/pull/1662) |
| [G-SDK-14](#g-sdk-14) | SDK | P2 | **Agreed** | Allowances one pair at a time — our two asks scheduled in the opposite order |
| [G-SDK-16](#g-sdk-16) | SDK | ~~P2~~ | **Closed** | `portfolios.delete({ portfolio: BigNumber })` threw — `instanceof` across duplicate `bignumber.js` copies, fixed in `31.1.0-beta.6` |
| [G-SDK-15](#g-sdk-15) | SDK | ~~P3~~ | **Won't fix** | *Withdrawn* — the chain rejects custody of a default portfolio; `NumberedPortfolio` alone is correct |
| [G-IDX-06](#g-idx-06) | Indexer | P3 | Open | No allowance entity — approvals have no history |
| [G-SDK-13](#g-sdk-13) | SDK | ~~P1~~ | **Closed** | History reads defaulted oldest-first — and `getPolyxTransactions` could not page at all |
| [G-SDK-18](#g-sdk-18) | SDK | P2 | **Agreed** | `getReceived` cannot page — the chain-paged half is not buildable; indexer half blocked on G-IDX-07 |
| [G-SDK-19](#g-sdk-19) | SDK | P2 | **In flight** | Indexer-backed reads hid `orderBy`/`filter`/`totalCount` — [PR #1662](https://github.com/PolymeshAssociation/polymesh-sdk/pull/1662) |
| [G-IDX-07](#g-idx-07) | Indexer | **P1** | Open | `authorizations.data` keeps the pre-migration payload, so it disagrees with the chain about which asset an authorization names |
| [G-IDX-08](#g-idx-08) | Indexer | P2 | Open | No balance or holding entity — a portfolio's contents can only be counted by asking the chain, once per portfolio |
| [G-IDX-09](#g-idx-09) | Indexer | P2 | Open | Numeric ids are `String` columns, so `ID_DESC` sorts lexicographically — the newest instruction is not first |
| [G-SDK-23](#g-sdk-23) | SDK | P2 | Open | No batch-size guidance — `utility.batch` is bounded by block weight and the SDK exposes no general limit |
| [G-SDK-20](#g-sdk-20) | SDK | P2 | Open | Unbounded storage scans behind plain-array reads — `getAssetBalances`, `getCollections` and five more |
| [G-SDK-21](#g-sdk-21) | SDK | P2 | **Split** | Settlement half agreed; MultiSig half **won't fix** — the chain records neither the vote action nor a block |
| [G-SDK-22](#g-sdk-22) | SDK | ~~P3~~ | **Closed** | *Premise wrong* — no Asset can lack a name; shipped as a round-trip saving |
| [G-SDK-24](#g-sdk-24) | SDK | P3 | **Agreed** | Permissionable map hand-maintained — spec stamp, `isPermissionable`, and upstream CI reconciliation |
| [G-SDK-11](#g-sdk-11) | SDK | ~~P3~~ | **Closed** | `MiddlewareConfig.key` is optional as of `31.1.0-beta.6` |
| [G-SDK-08](#g-sdk-08) | SDK | P3 | In flight | `eth-signing-manager` dual CJS+ESM build |
| [G-SDK-09](#g-sdk-09) | SDK | P3 | Open | Remaining signing managers need dual builds — gated on G-SDK-05 |
| [G-EXT-01](#g-ext-01) | Extension | P3 | Open | No confidential (ElGamal) key management |
| [G-SDK-06](#g-sdk-06) | SDK | ~~P1~~ | **Closed** `31.1.0-beta.3` | Read-only connect failed where WASM is forbidden |
| [G-SDK-07](#g-sdk-07) | SDK | ~~P2~~ | **Closed** `31.1.0-beta.3` | NFTs could only be minted to a portfolio |
| [G-SDK-10](#g-sdk-10) | SDK | ~~P3~~ | **Won't fix** | *Withdrawn* — self-registration is always permitted; the constraint is funding |
| [G-SDK-17](#g-sdk-17) | SDK | ~~P2~~ | **Won't fix** | *Withdrawn* — CDD claims are meaningless as of chain v8 |

**The Phase-5 pattern.** `G-IDX-02` through `G-IDX-05` are one request, not four: every Phase-5
feature in the charter that *has* SDK support — ballots, checkpoints, corporate actions, subsidies —
has **zero** indexer coverage. Take them to the indexer team together.

---

## SDK

<a id="g-sdk-01"></a>
### G-SDK-01 — `sdk.staking` has no `rebond` and no `chill`

- **Owner:** SDK · **Priority: P1** · **Status: Closed** — shipped in `31.1.0-beta.6` as
  `staking.rebond` and `staking.chill`, verified in the installed type declarations 2026-08-27.
  **Revisit:** delete the two raw writes from `packages/chain/src/raw/index.ts` and its inventory,
  and with them `tx.utility.batchAll`, which exists only to batch those two.
- **Blocks:** `P-STK-04`, `P-STK-07`

v1 ships **nine** staking actions (`EModalActions` in `layouts/Staking/.../constants.ts`): `bond`,
`bondExtra`, `unbond`, `rebond`, `withdrawUnbonded`, `nominate`, `chill`, `setController`,
`setPayee`. `sdk.staking` covers seven. `rebond` and `chill` have no SDK method.

Both exist on the runtime — the `Staking` pallet carries 32 dispatchables including `rebond` and
`chill`.

`chill` matters most: it is the only way to **stop nominating without unbonding**. Without it a user
who wants out of a validator set must unbond and wait the full bonding duration.

- **Closing it:** add `sdk.staking.rebond(params)` and `sdk.staking.chill()`.
- **Workaround:** `CHAIN tx.staking.rebond` / `tx.staking.chill` behind the `packages/chain` staking
  adapter. Works, but puts two *parity* actions on the raw layer rather than only enhancements.

<a id="g-sdk-02"></a>
### G-SDK-02 — No era-progress derivation or per-era staking reads

- **Owner:** SDK · **Priority: P2** · **Status: Closed** — `31.1.0-beta.6`. `staking.eraProgress()`
  (with a subscription overload), `getConstants()`, `getEraRewardPoints()`, `getEraValidatorReward()`,
  `getEraStartSession()`, `getEraExposure()`, `getEraNominators()`, `getElectionPhase()`,
  `getActiveValidators()`, `getValidatorCount()`, and `Network.getTotalIssuance()`.
  `StakingConstants` carries `fixedYearlyReward` and `maxVariableInflationTotalIssuance`, so the
  inflation inputs are covered too. **Revisit:** `packages/chain/src/raw/era.ts` and its inventory
  block can go — the SDK now answers every read in it. Note `StakingEraInfo.activeEraStart` is
  documented as **milliseconds since epoch** and `0` where the chain holds no start, and
  `eraInfo().totalStaked` changed from raw units to POLYX, so any `÷ 1e6` we carry must come out.
- **Blocks:** nothing; costs a reimplementation. `P-STK-11`, `P-STK-13`, `P-STK-15`, `P-STK-16`

Full detail and testnet measurements in
[ADR-0006](adr/0006-staking-raw-chain-access.md#the-gap-for-the-sdk-team). In priority order:

1. **Era progress.** Rendering "era 7131, 4h12m remaining" needs `babe.genesisSlot`,
   `babe.currentSlot`, `babe.epochIndex`, `consts.babe.expectedBlockTime`,
   `consts.staking.sessionsPerEra`, `session.currentIndex`. `eraInfo()` returns the era but not
   enough to compute progress. **This is the single most valuable addition** — pure derivation the
   SDK could own, that every consumer otherwise rewrites.
2. **Per-era exposure and reward points** — `erasStakersOverview`, `erasStakersPaged`,
   `erasRewardPoints`, `erasValidatorReward`, `erasTotalStake`, `erasStartSessionIndex`.
3. **`consts.validators.fixedYearlyReward`** — the APY input, Polymesh-specific.
4. **`consts.staking.bondingDuration`** — unbonding timelines. Trivial.
5. **`electionProviderMultiPhase.currentPhase`** — staking actions behave differently during an
   election and the UI should say so.

- **Workaround:** `sdk._polkadotApi`, all 19 calls verified on testnet. Zero extra bytes.

<a id="g-sdk-03"></a>
### G-SDK-03 — Confirm `sdk.staking.withdraw` computes `numSlashingSpans`

- **Owner:** SDK · **Priority: P3** · **Status: Closed** — `develop@69c6a5247`.
  `prepareWithdrawUnbondedPolyx` reads `staking.slashingSpans` keyed by the **stash**, which is the
  case we were worried about, and it was fixed for that reason. We asked for "a documentation note,
  or a test"; both exist.

`withdraw` is a `NoArgsProcedureMethod`, so it presumably reads `slashingSpans` internally. Worth
confirming: a wrong span count is a **silent** failure — the extrinsic succeeds and withdraws nothing.

- **Closing it:** a documentation note, or a test. Not a code change if it already works.

<a id="g-sdk-04"></a>
### G-SDK-04 — No `payoutStakers`, no validator-side operations

- **Owner:** SDK · **Priority: P3** · **Status: Open**

No `payoutStakers` / `payoutStakersByPage`; no `validate`, `setCommission`, `kick`, `chillOther`.

Low priority for the Portal specifically — Polymesh pays rewards automatically, and operator
self-service is a different audience. Recorded so the SDK roadmap has the complete picture.

<a id="g-sdk-13"></a>
<a id="g-sdk-19"></a>
### G-SDK-19 — Indexer-backed reads do not expose the ordering and filtering the query already supports

- **Owner:** SDK · **Priority: P2** · **Status: In flight** —
  [PR #1662](https://github.com/PolymeshAssociation/polymesh-sdk/pull/1662), *“Ordering, filtering
  and paging for indexer-backed reads”*, opened by us and expected to merge 2026-08-27. It adds an
  optional `orderBy` to nine public read methods, builds filters from supplied attributes rather
  than hard-coded GraphQL, honours falsy filter values (`0`, `''`, `false` were being skipped), and
  adds a unique tiebreaker to ten paginated queries that had none — three had no `orderBy` at all
  and seven ordered by block only, so pages could repeat or skip rows. **Revisit on merge:** the
  ordering half is the same defect we filed as [G-IDX-09](#g-idx-09) from the other side, so check
  whether our `CREATED_EVENT_ID_*` orderings in `packages/data/src/indexer/` are still needed or
  become the SDK's job.
- **Use case:** every list in `(app)` — see [spec/list-contract.md](spec/list-contract.md)

Some SDK reads page over **chain storage** and some page over the **indexer**, and the two have
fundamentally different capabilities:

| | Chain paging | Indexer paging |
|---|---|---|
| Cursor | storage key | offset / cursor |
| Ordering | **none** — trie order is not a sequence | any indexed column |
| Total count | **none** | `totalCount` |
| Filtering | only what the storage layout keys on | any indexed column |

The SDK presents both through the same `PaginationOptions` → `ResultSet` shape, which is good for
callers but means the **indexer-backed reads inherit the chain-shaped API and lose what they could
do**. The underlying GraphQL query accepts `orderBy` and `filter`; the SDK method does not offer
them.

The consequence is not inefficiency, it is impossibility: a caller that wants "most recent first"
from an indexer-backed read has no way to ask, and re-implementing the query outside the SDK is the
only route — which is what [G-SDK-12](#g-sdk-12) already forced for holdings and
[G-SDK-18](#g-sdk-18) for authorizations. Each such workaround is a second copy of a query the SDK
already owns.

**Ask:** where a read is indexer-backed, surface the query's own capability —

1. `orderBy` on the columns the entity indexes;
2. `filter` on the same;
3. `totalCount` alongside the page.

And, so callers can tell the two apart at all, some way to know **which** kind of paging a given
read uses. Today that requires reading the SDK source. A chain-paged read and an indexer-paged read
support different UI, and a caller that cannot distinguish them must assume the weaker.

**Related:** [G-SDK-13](#g-sdk-13) is the same theme at one call site — ordering that exists in the
query but not in the method signature.

<a id="g-sdk-18"></a>
### G-SDK-18 — `getReceived` cannot page, on the one list that most needs it

- **Owner:** SDK · **Priority: P1** · **Status: Open**
- **Use case:** the Console work queue and Identity authorizations (`P-AUTH-01`, `P-UX-03`)

`Authorizations.getReceived()` returns `Promise<AuthorizationRequest[]>` — a plain array, with
`type` and `includeExpired` as its only options. There is no `PaginationOptions`, no ordering, and
no count.

Its neighbours all page. In the same class, `getSent` takes `PaginationOptions` and
`getHistoricalAuthorizations` takes `size`/`start` plus `status` and `type` filters. Across the SDK,
**36** methods return a paginated `ResultSet` and **19** accept `PaginationOptions` — so the shape
exists and this read is an exception to it.

**The scale is not hypothetical.** A live testnet identity used in the 2026-08-23 build audit has
**1,006** pending authorizations, almost all `PortfolioCustody` invitations. `getReceived()` reads
every one of them from chain storage on every render of a surface that shows eight.

Ordering matters as much as paging: without it there is no "most recent" and no stable page
boundary, so even client-side paging over the array cannot be made correct across refetches.

**Ask:**

1. `getReceived(paginationOpts?: PaginationOptions)` returning `ResultSet<AuthorizationRequest>`,
   consistent with `getSent`;
2. ordering, or at minimum a documented stable order;
3. the `status` filter that `getHistoricalAuthorizations` already accepts.

**What we do meanwhile.** Implemented 2026-08-23 in `packages/data/src/indexer/authorizations.ts`
and `packages/chain/src/domains/authorizations.ts`: list from the indexer, confirm each row on
screen against the chain. Deleted when this closes — both modules name this ID so the interim path
can be found and removed.

Four things the implementation had to discover, none of them in the schema docs:

- **The list must match `toKey` as well as `toId`.** A `JoinIdentity` authorization targets a key
  that has no identity yet, so its `toId` is `null` — 215 pending on testnet. Filtering on the DID
  alone hides the invitation completely. `toKey` is the **hex public key**, not SS58.
- **Offset paging needs a tiebreaker.** `CREATED_BLOCK_ID_DESC` alone is not a total order — the
  audited identity's top rows share a block — so a row could appear on two pages or on neither.
  `ID_DESC` is appended to every ordering.
- **`createdBlockId` is a zero-padded string** (`"0005909712"`), which is what makes a
  lexicographic comparison agree with a numeric one. Comparing against an unpadded value returns a
  rank of 0 — silently, and looking like it worked.
- **`TYPE_ASC` sorts by the enum's ordinal, not alphabetically**, because it is a Postgres enum:
  `PortfolioCustody` sorts before `BecomeAgent`. Sorting by type therefore groups rather than
  alphabetises. Not a defect, but not what a column header implies either.

Verified against live testnet 2026-08-23: `totalCount` 1,006; authorization `49292` at rank **311**,
which is page 13 at 25 a page — the deep link now pages to it. Recorded in
[spec/list-contract.md](spec/list-contract.md).

<a id="g-sdk-13"></a>
### G-SDK-13 — History reads default to oldest-first, and one cannot be ordered at all

- **Owner:** SDK · **Priority: P1** · **Status: Closed** — `31.1.0-beta.6`. `getTransactionHistory`
  flips to `IdDesc`, `getPolyxTransactions` gains `orderBy`, and the default is `IdDesc` rather than
  `CreatedBlockIdDesc` because the indexer's `id` is `<padded block>/<padded event index>` and is
  therefore both unique and correctly ordered on its own.

  **It was worse than we filed it, in a way we could not have seen.** `polyxTransactionsQuery` never
  selected `totalCount`, so `count` was `NaN`, `next` derives from `totalCount.gt(next)`, and a
  `NaN` comparison is always false — `getPolyxTransactions` **could not be paged past its first
  page at all**. We only ever asked it for five rows on the Console, so we never met it.
- **Use case:** every "recent activity" surface — the Console, the Identity screen, transfer history
- **Found:** 2026-08-22, against a real testnet identity with **11,712 extrinsics**. The Portal's
  five-row activity list showed the first five extrinsics that key ever signed, in 2023. It looked
  like missing data; it was the default sort.

Two separate problems, one symptom.

**1. `account.getTransactionHistory()` defaults to `ExtrinsicsOrderBy.IdAsc`.** Oldest first. Every
caller that wants recent history — which is every caller — has to know to override it, and one that
does not gets a plausible-looking list of the wrong rows. There is no error and nothing looks broken.

*Ask:* default to `IdDesc`. "Most recent" is what a history is for, and the current default is only
correct for an exhaustive export.

**2. `account.getPolyxTransactions()` accepts no ordering at all.** `polyxTransactionsQuery`
hard-codes `PolyxTransactionsOrderBy.CreatedBlockIdAsc`, and the method's filters are `size` and
`start` only. So the newest POLYX movements are unreachable except by offset arithmetic — read the
`count`, ask again at `count - size`, reverse the page. Two round trips and a race: anything that
lands between them shifts the offset.

*Ask:* an `orderBy` on the method, defaulting to newest-first, as `getTransactionHistory` and
`getHeldAssets` already accept.

This is P1 rather than P2 because the failure is **silent and plausible**. A missing method is
noticed the moment it is called; a wrong default renders real data from the wrong end of history, and
the only way to catch it is to compare against another tool — which is how this was found.

**What we do meanwhile.** `getTransactionHistory` is passed `ID_DESC` explicitly.
`getPolyxTransactions` gets the offset dance, in `packages/chain/src/domains/activity.ts`, with the
race documented at the call site. Both revert to one-liners when this closes.

<a id="g-sdk-16"></a>
### G-SDK-16 — `portfolios.delete({ portfolio: BigNumber })` throws a TypeError

- **Owner:** SDK · **Priority: P2** · **Status: Closed** — `31.1.0-beta.6`. The cause was not the
  procedure destructuring, as guessed below: `Portfolios.delete` tested `portfolio instanceof
  BigNumber`, and with two copies of `bignumber.js` in the tree that is **false for a real
  BigNumber**, so the argument fell to the entity branch and `portfolio.id` was `undefined`. It now
  uses `BigNumber.isBigNumber`, which is copy-safe. **Revisit:** `deletePortfolio` in
  `packages/chain/src/domains/portfolios.ts` fetches the entity first purely to avoid this — one
  read to delete.
- **Use case:** deleting a portfolio (`P-PF-06`)

The signature is

```ts
delete: ProcedureMethod<{ portfolio: BigNumber | NumberedPortfolio }, void>;
```

but `prepareDeletePortfolio` destructures `{ did, id }` off its argument. Given a `BigNumber` there
is no `id`, so it reaches `bigNumberToU64(undefined)` and throws:

```
Cannot read properties of undefined (reading 'isInteger')
```

A **TypeError from a documented signature** — not a chain rejection, not a validation message. It
type-checks, so nothing catches it until it runs. Reproduced against a v8 dev chain, 2026-08-23; the
`NumberedPortfolio` form works.

- **Closing it:** resolve the id to an entity inside the procedure, as the entity branch already
  does — or narrow the type to `NumberedPortfolio` if the id form was never meant to work.

**What we do meanwhile.** `deletePortfolio` fetches the entity first. One extra read, deleted when
this closes.

<a id="g-sdk-15"></a>
### G-SDK-15 — ~~`setCustodian` is not exposed on a default portfolio~~ ❌ Withdrawn

- **Owner:** SDK · **Priority: ~~P3~~** · **Status: Won't fix — withdrawn by us, 2026-08-27**

**We were wrong and the SDK was right.** The chain rejects custody of a default portfolio with
`DefaultPortfoliosCannotHaveCustodians`; `add_authorization` does not check, so exposing it would
only ever produce an authorization request that can never be accepted. `31.1.0-beta.6` says so and
narrows `SetCustodianParams.id` from optional to **required**. Keeping it on `NumberedPortfolio`
alone is the correct API. Original text kept below for the record.
- **Use case:** custody (`P-PF-08`)

`setCustodian` is a method on `NumberedPortfolio` only. `DefaultPortfolio` has `quitCustody` but no
way to *grant* custody, so a default portfolio can be taken into custody and then never given away
again through the SDK.

**The chain allows it.** `AuthorizationData::PortfolioCustody` carries a
`PolymeshPrimitivesIdentityIdPortfolioId`, whose `kind` is `{ Default | User(u64) }` — checked
against v8 metadata, 2026-08-23. So this is an SDK omission rather than a chain rule.

Low priority: custodying a default portfolio is an unusual thing to want, and the asymmetry is only
visible to someone looking for it. Recorded so it is not mistaken for a chain constraint later.

**What we do meanwhile.** The Portfolio menu offers custody on numbered portfolios only. No raw
workaround — one more escape hatch is not worth an uncommon action.

<a id="g-sdk-14"></a>
### G-SDK-14 — Allowances can only be read one `(owner, spender)` pair at a time

- **Owner:** SDK · **Priority: P2** · **Status: Agreed** — scheduled, **with our two asks in the
  opposite order**.

**We had the storage key backwards.** It is
`allowances: (AccountId32 /* owner */, AccountId32 /* spender */, AssetId) -> u128`, and the
runtime's own doc says *"Uses `StorageNMap` so that all allowances for a given owner can be iterated
via prefix."* So our **second** ask — the account-level read that names no asset — is the cheap one,
a single `entries(owner)` prefix scan; our **first**, per-asset, is the awkward one, because the
asset is the *last* key. The account-level read is being built first and the per-asset view derived
from it — which serves our stated use case ("what have I approved, and to whom") anyway.

Our footnote was right and is being acted on: revoking is `approve(spender, 0)`, so any listing
filters zeroes — pending a check of whether the chain removes the entry or writes a zero, which
decides whether `count` can come from the map's length.
- **Use case:** the allowances screen (`P-PF-18`) — *what have I approved, and to whom*

`FungibleAsset.getAllowance({ owner, spender })` needs both sides up front. That answers "may this
spender move this asset", which is the check a spender's own flow makes; it cannot answer the
question a **holder** asks, which is the only one an allowances screen exists for.

The chain stores it as a triple map `(assetId, owner, spender) → Balance`, so a partial-key
iteration over `(assetId, owner)` is cheap and exact. What is missing is the SDK exposing it — and,
more usefully, indexing it the other way round so `owner` alone is answerable.

**Ask**, in the order they would help:

1. `asset.getAllowances({ owner })` — every spender on one asset, paginated;
2. an account-level `getAllowances()` that does not require naming the asset first. Without it a
   caller must enumerate the owner's assets and query per asset, which is what we do now.

Also note **revoking sets the amount to `0` rather than removing the row**, so any listing must
filter zeroes or it reports revoked allowances as live ones. Worth documenting on whichever method
lands.

**What we do meanwhile.** `packages/chain/src/raw/allowances.ts` runs the partial-key iteration,
listed in the `raw/index.ts` inventory. It is deleted when this closes.

<a id="g-sdk-12"></a>
### G-SDK-12 — `getHeldAssets` cannot ask for assets *currently* held

- **Owner:** SDK · **Priority: P2** · **Status: In flight** —
  [PR #1662](https://github.com/PolymeshAssociation/polymesh-sdk/pull/1662) adds
  `Identity.getAssetHoldings()`, which returns holdings **with amounts** and takes a `heldNow`
  option that excludes zero-balance records; `getHeldAssets()` is deprecated by it. **Revisit on
  merge:** this is precisely what `packages/data/src/resources/holdings.ts` exists to work around —
  the one place `packages/data` queries the indexer for something the SDK should answer. Deleting it
  removes a documented deviation rather than merely a workaround.
- **Use case:** the Console's holdings summary, and Holdings (`P-PF-01`, `P-PF-02`)

`identity.getHeldAssets()` answers "assets held **at some point**". There is no way to ask for the
ones with a balance now, and the returned `FungibleAsset` carries no balance, so the caller makes one
more chain read per asset to find out.

The information is already in the row the SDK reads. `assetHoldersQuery` selects only
`asset { id ticker }` from an `AssetHolder` node whose fields are:

```
nodeId  id  identityId  assetId  amount  createdBlockId  updatedBlockId  identity  asset  ...
```

— and it filters on `identityId` alone. Verified against a live SubQuery instance, 2026-08-22.

**Filtering client-side is wrong, not merely wasteful.** The page is drawn before the filter runs, so
asking for 5 rows and dropping the zeroes can return 2 while more exist — the count and the
pagination cursor both become fiction. Getting the balances to filter by costs a chain read per
asset: on a 50-row page, a hundred round trips to render five lines.

**Ask**, in the order they would help:

1. a filter — `getHeldAssets({ heldNow: true })` or equivalent — applied in the query, so pagination
   stays honest;
2. the `amount` on each result, since the row already carries it. This alone removes the N+1.

The same applies to `getHeldNfts`, whose `nftHolders` query has the identical shape.

**What we do meanwhile.** `packages/data/src/resources/holdings.ts` runs the query the SDK would:
`assetHolders(filter: { identityId, amount: { greaterThan: "0" } }, orderBy: [AMOUNT_DESC])`, one
request, with the amount. It is the only `(app)` read that does not go through the SDK, it is
labelled as such, and it is deleted when this closes.

<a id="g-sdk-11"></a>
### G-SDK-11 — `MiddlewareConfig.key` is required for indexers that need no auth

- **Owner:** SDK · **Priority: P3** · **Status: Closed** — `31.1.0-beta.6` makes `key` optional and
  omits the header rather than sending it empty. **Revisit:** `packages/chain/src/connect.ts` passes
  `key: ''`; drop it.
- **Use case:** connecting the client SDK to a SubQuery endpoint

```ts
export interface MiddlewareConfig {
  link: string;
  key: string;   // required
}
```

Polymesh's own public indexers — mainnet, testnet, and a local `polymesh-dev-env` — take no API key.
The only way to satisfy the type is `key: ''`, which the SDK then sends as an empty `x-api-key`
header. v1 does exactly this in production, so the empty-string sentinel is already the de-facto
convention; it just is not the one the type describes.

The cost is small and entirely in clarity: `key: ''` reads like a bug or a stripped secret to anyone
reviewing it, and it has to be explained at every call site.

- **Closing it:** make `key` optional, and omit the header when it is absent. No behaviour change for
  callers that pass one.

### G-REST-05 — No asset enumeration endpoint

- **Owner:** REST · **Priority: P3** · **Status: Open** — *not blocking; the indexer is the intended
  source*
- **Use case:** the public, crawlable asset directory and `sitemap.ts`
  ([ADR-0011](adr/0011-the-public-asset-directory-and-sitemap.md)).

There is no way to list assets over REST. `/assets` is 404, and `/assets/list` is just
`/assets/{asset}` rejecting `list` as a malformed ID. Every asset route requires an ID you already
have.

The public surface's entire premise is that a crawler discovers asset pages it has never seen, so the
directory and sitemap can only be built from the indexer's `assets` connection. That is workable —
and it is what we do — but it makes the **indexable** surface single-sourced, which is the one place
the charter says a public page must never hard-fail. Chain state has a REST→indexer fallback;
enumeration has no fallback at all, because REST cannot answer it.

**Resolution (2026-08-22): stay on the indexer.** Enumerating every asset is an expensive chain read —
it is a full storage-map scan, which is exactly the kind of query REST should not encourage, and any
REST or SDK version of it would have to be paged anyway. The indexer already stores this shape and
pages it cheaply, so it is the right home rather than a workaround.

Recorded, not withdrawn, because the underlying observation still stands: the indexable surface is
single-sourced and has no REST fallback. That is an accepted risk, not an oversight — if it is ever
revisited, the ask is a paginated `GET /assets` returning `{ assetId, name, ticker, assetType, owner }`
with a stable sort so pagination can resume.

### G-REST-06 — A ticker resolves in the `{assetId}` path position

- **Owner:** REST · **Priority: P3** · **Status: Open**
- **Use case:** canonical asset IDs on a cached, indexable page.

`GET /assets/{assetId}` accepts a UUID, a `0x` hex ID **and a ticker**, all returning the same asset.
The validation message says as much: *"asset must be either a Ticker (12 characters uppercase string)
or an Asset ID (34 characters long hex string)"* — though note it omits the UUID form, which is
accepted in practice and is what the response's own `assetId` field returns.

Tickers are no longer identity in v8: they are optional, transferable labels that can be unlinked and
relinked to a different asset. So the same URL can silently resolve to a different asset over time.
For a page that is server-rendered, ISR-cached and served to crawlers, that is a correctness problem
rather than a convenience — a stale or mistyped ticker returns a confident 200 for the wrong asset
instead of a 404.

**Ask:** either restrict `{assetId}` to real asset IDs and move ticker lookup to an explicit route
(`/assets/by-ticker/{ticker}`, or a `?ticker=` query), or return the resolution in the response so a
caller can detect that it asked by a mutable name. Our side is already covered — `packages/data`
sends only the canonical UUID — so this is about not leaving the trap set for the next consumer.

### G-REST-07 — An asset detail page costs five round trips

- **Owner:** REST · **Priority: P2** · **Status: Open**
- **Use case:** `(public)` SSR inside a Cloudflare Worker, where CPU per render is the budget.

Rendering one public asset page needs `/assets/{id}`, `/assets/{id}/holders`,
`/assets/{id}/compliance-requirements`, `/assets/{id}/documents` and `/assets/{id}/metadata`. Each is
a separate HTTP round trip from the Worker, and each is separately cached, so they can also disagree
about which block they reflect.

This is the constraint that decides our data-source split, so it is worth being concrete:
[ADR-0003](adr/0003-sdk-server-side-in-the-worker-runtime.md) measured a REST-backed SSR at **156 ms
CPU** against **644–695 ms** for an SDK-backed one, and that REST figure is for a page making *two*
calls. The round-trip count is the main lever we have left on public-page cost.

**Ask:** a composite read — `GET /assets/{id}?include=holders,compliance,documents,metadata`, or a
dedicated `/assets/{id}/overview` — returning one consistent snapshot. Read-only, so it is a
projection rather than new semantics. Failing that, a documented statement of which sub-resources are
cheap enough to fan out would let us budget properly.

### G-REST-08 — `developer-testing` cannot create identities against a v8 chain

- **Owner:** REST · **Priority: P3** · **Status: Open**
- **Use case:** seeding a local `polymesh-dev-env` for Tier 2/3 test runs.

`POST /developer-testing/create-test-accounts` (and `create-test-admins`) returns
`500 Internal Server Error`, with `Internal: At least one identity was not found which should have
been made` in the container log. Reproduced on `polymeshassociation/polymesh-rest-api:latest`
(SDK 30.0.0) against a spec-8.1.0 dev chain.

Two chain changes are the likely cause, both confirmed against v8 metadata:

- the **`testUtils` pallet is absent** from the runtime entirely, and
- CDD providers moved from `cddServiceProviders` to **`didRegistrars`**.

Worth noting the shape of the dev chain this has to work against, because it is not what the endpoint
seems to assume: the sole registrar is the genesis DID, whose *primary* key is none of the well-known
dev accounts — Alice, Bob, Charlie, Dave and Eve are all *secondary* keys of it, and Ferdie has no
identity at all. Alice does hold sudo.

**Ask:** confirm whether this is fixed by the SDK v31 bump in
[rest-api#369](https://github.com/PolymeshAssociation/polymesh-rest-api/pull/369). If it is, this
closes with that release. If it is not, the endpoint needs to register identities the way a v8 chain
actually supports — `identity.cddRegisterDid` signed by a key of a `didRegistrars` member — rather
than through `testUtils`.

**Superseded in practice by self-registration.** `POST /identities/self-register` and the SDK's
`identities.selfRegisterDid()` both work against v8, verified on the dev-env: a funded key registers
its own DID with no registrar involved. The seeder now uses that, which is *better* than the endpoint
it was working around — it removes the dependency on this chain's genesis CDD configuration entirely,
so the same seeder would work anywhere a faucet does.

So this stays filed for the REST team's awareness, at low priority. It is no longer costing us
anything.

### G-SDK-05 — A dual-format `@polkadot` load, originating in `polymesh-sdk`

- **Owner:** **SDK core** *(was: SDK / signing-managers)* · **Priority: P2** · **Status: Open** — retargeted
- **Use case:** the EVM connector (`P-CON-03`) in an ESM, bundler-resolved app.

Importing the SDK stack from ESM loads `@polkadot/*` **twice**, once per module system, and
polkadot-js says so at runtime:

```
@polkadot/util has multiple versions, ensure that there is only one installed.
	cjs 13.5.9	node_modules/@polkadot/util/cjs
	esm 13.5.9	node_modules/@polkadot/util/
```

It is **not** a version conflict — `yarn why` shows a single 13.5.9 throughout, and our `resolutions`
already pin the SDK's exact versions. It is one package loaded twice, which polkadot-js warns causes
subtle breakage because `isReady` and registry state are module-level.

> **Correction (2026-08-22).** This was first filed against `@polymeshassociation/eth-signing-manager`,
> on the reasoning that it was the one CJS-only package among otherwise-dual-build siblings. **That
> comparison was asserted without reading a single manifest, and it is wrong.** Read from the
> published packages:
>
> | package | `main` | `module` | `type` | `exports` |
> |---|---|---|---|---|
> | `polymesh-sdk@31.1.0-beta.3` | – | – | – | – |
> | `local-signing-manager@4.1.1` | – | – | – | – |
> | `browser-extension-signing-manager@2.5.0` | – | – | – | – |
> | `walletconnect-signing-manager@2.0.0` | – | – | – | – |
> | `hashicorp-vault-signing-manager@4.1.0` | – | – | – | – |
> | `fireblocks-signing-manager@3.0.0` | – | – | – | – |
> | `eth-signing-manager@1.0.1` | `./index.js` | – | – | – |
>
> Verify with
> `curl -s https://unpkg.com/@polymeshassociation/polymesh-sdk/package.json | jq '{main, module, type, exports}'`.
>
> Every one is flat CJS resolved through Node's implicit `index.js` fallback — the exact shape
> `eth-signing-manager` was faulted for, and it is the only one that even declares `main`.
>
> **Why that changes the fix.** Export-condition resolution is decided by the *importer*, not the
> package. `@polkadot/util@13.5.9` maps `require` → `./cjs/index.js` and `module`/`default` →
> `./index.js`. So in an ESM app: our code imports `@polkadot/util` and gets the ESM branch, while
> `polymesh-sdk` (CJS) `require`s it — and `@polkadot/api` does the same beneath it — pulling the CJS
> branch. Both load. `eth-signing-manager` was a third participant, not the cause, and fixing it alone
> cannot clear the warning, because the SDK keeps the CJS branch alive on its own and is by far the
> larger consumer of `@polkadot/*`.
>
> **Our own session is the evidence.** The warning first fired in a probe script that imported
> `polymesh-sdk`, `local-signing-manager` and `@polkadot/keyring`, and **never imported
> `eth-signing-manager`** — it was in `node_modules` but not in the module graph. The warning predates
> that package's involvement entirely.
>
> [ADR-0001](adr/0001-polymesh-sdk-under-next-app-router.md) already records that the SDK's tree is
> CJS and does not shake. That fact was available and the newest package in the graph got blamed
> instead of the largest consumer.

**Ask:** publish `polymesh-sdk` as dual CJS+ESM with a conditional `exports` map. **This is the one
that determines whether the warning goes away — nothing downstream can fix it.** The signing managers
are [G-SDK-09](#g-sdk-09), and are only worth scheduling after this.

**Cost to us — measured in Phase 1.3, and smaller than expected.** The prediction was that the
`(app)` client bundle would ship `@polkadot/util`, `util-crypto` and `wasm-crypto` twice. **It does
not.** Built with all three connectors in the graph and counted by each package's own
self-registration:

| package | registrations in the `(app)` client bundle |
|---|---|
| `@polkadot/util` | **1** |
| `@polkadot/util-crypto` | **1** |
| `@polkadot/api` (and `api-derive`, `rpc-core`, `rpc-provider`, `types`, `types-codec`, `types-create`, `types-known`) | **1** each |

`EthSigningManager` is bundled into the same 1.8 MB lazy chunk as the rest, so even the CJS-only
package resolves to the one branch. **Turbopack deduplicates the two export conditions**; the
dual-load is a *Node runtime* phenomenon — it fires in vitest, in scripts, and anywhere both branches
are `require`d and `import`ed in one process — not a bundler one.

That narrows this ticket considerably. What remains is real but bounded: duplicate module state in
**Node**, which is where our Tier 1/2 suites and any server-side SDK use live.

**Escalation trigger — this is not only bundle weight.** `@polkadot/wasm-crypto` holds its init state
at module scope, so two copies mean `cryptoWaitReady()` awaited against one instance leaves the other
uninitialised; the same applies to `@polkadot/types` registry state. That connects directly to a rule
we already have: [ADR-0003](adr/0003-sdk-server-side-in-the-worker-runtime.md) says never pass
`initWasm: false` on the client, because `cryptoWaitReady()` initialises the signing backend and
`sr25519` has no JS fallback. With two copies, a client that did everything right can still await
readiness against the wrong instance — presenting as exactly the broken-`sr25519` symptom ADR-0003
warns about, with no traceable cause.

**Scope: the ask is a dual build, not tree-shaking.** Checked before asking, because "while you are
in there, make it shakeable" is the obvious follow-up and it is not worth the SDK team's time. ESM
output is a *prerequisite* for shaking but nowhere near sufficient here — four independent blockers,
all read from the installed `31.1.0-beta.3`:

| Blocker | Evidence |
|---|---|
| The `internal.js` barrel | **170 of 223** source files require it; it exists to break circular dependencies, and a bundler seeing a cycle through a barrel retains the whole component |
| A side-effect import at the entry | `index.js` requires `polymesh-types/polkadot/augment-api`, which chains to the consts/query/tx/rpc augmentations. Those mutate the polkadot type registry, so the entry can never be marked side-effect-free |
| Eager namespace construction | `Polymesh`'s constructor builds all seven of Claims, Network, Settlements, AccountManagement, Identities, Assets, Staking — touching `sdk.assets` retains `Staking` and its procedures |
| `@polkadot/api` is metadata-driven | `api.tx.*` / `api.query.*` are decorated at runtime from chain metadata. There is no static graph to shake |

The last one caps the payoff: the SDK is not the weight, `@polkadot` is, and its runtime-metadata
design is structurally unshakeable for the decorated API. A large refactor would win a modest
fraction of a chunk ADR-0003 measured at ~610 kB gzip. Our own lever is the one
[ADR-0001](adr/0001-polymesh-sdk-under-next-app-router.md) already chose — keep the SDK out of
`(public)` entirely and lazy-load it in `(app)` — which is a 100% saving on public pages rather than
a speculative fraction in the app. **Not requested.**

**Two things the dual build itself should carry**, because it moves this bug class up a level rather
than removing it:

1. **Guard the dual-package hazard.** If any path `require`s the SDK while another `import`s it,
   there are two copies of the SDK, and `instanceof` stops working across them — `entity instanceof
   Asset`, `PolymeshTransaction` checks, `BigNumber.isBigNumber` (we hit the BigNumber version of
   this already and fixed it with a `resolutions` pin). So: no module-level mutable state, and one
   `default` per condition in the map so a mixed graph cannot split.
2. **`exports` is a hard gate.** Adding the map stops every *unlisted* subpath resolving —
   `polymesh-sdk/types`, `polymesh-sdk/api/entities/...`. We import `polymesh-sdk/types` and would
   need it mapped; other consumers deep-import more freely. It needs a complete subpath map, and
   probably a major.

**The trigger did not fire.** Phase 1.3 measured one copy, not two, so this stays P2. Restating it
for the future: **if any build ever shows two live copies of `@polkadot/wasm-crypto` in the `(app)`
bundle, this goes P1** — it stops being bundle weight and becomes a correctness risk in the signing path.

### G-SDK-08 — `eth-signing-manager` dual CJS+ESM build

- **Owner:** SDK / signing-managers · **Priority: P3** · **Status: In flight**
- **Use case:** the EVM connector (`P-CON-03`); the smaller half of [G-SDK-05](#g-sdk-05).

Split out from `G-SDK-05` so the release is not blocked behind SDK-core work.

`eth-signing-manager` now builds dual CJS+ESM with a conditional `exports` map (types-first per
branch), verified green by `attw` across node10 / node16-CJS / node16-ESM / bundler. Its ESM entry
resolves `@polkadot/util/index.js`; its CJS entry resolves `@polkadot/util/cjs/index.js`.

**Implemented and verified locally; not yet merged or published** — which is why this is *In flight*
rather than *Closed*. It flips to Closed with a version number on publish, and moves to the
[Closed](#closed) section then. The register's Closed entries are useful precisely because they name
a version we can depend on (`G-SDK-06`/`G-SDK-07` name `31.1.0-beta.3`); an entry we could not point
a dependency at would devalue that.

**On its own this changes nothing observable.** The dual-load warning is the SDK's, per
[G-SDK-05](#g-sdk-05).

### G-SDK-09 — The remaining signing managers need dual builds

- **Owner:** SDK / signing-managers · **Priority: P3** · **Status: Open** — **gated behind
  [G-SDK-05](#g-sdk-05)**
- **Use case:** the connect flow's non-EVM paths (`P-CON-01`, `P-CON-02`) and the custody seam.

`local-signing-manager`, `browser-extension-signing-manager`, `walletconnect-signing-manager`,
`hashicorp-vault-signing-manager` and `fireblocks-signing-manager` are all flat CJS (see the table in
`G-SDK-05`), each contributing its own smaller duplicate surface.

**Do not schedule this before `G-SDK-05`.** Until the SDK ships a dual build it keeps the CJS branch
alive by itself, so fixing these changes nothing measurable — the same trap as blaming
`eth-signing-manager` in the first place.

**The grouping pattern.** Like `G-IDX-02`…`G-IDX-05`, these are one request rather than five: they
share an owner, a fix and a release process. Take them to that team together, after `G-SDK-05`.

### Noted, not requested: subscriptions over HTTP fail loudly

Checked on 2026-08-22 and **found to be a non-issue**, recorded so it is not re-investigated.

[ADR-0003](adr/0003-sdk-server-side-in-the-worker-runtime.md) makes `HttpProvider` the server
transport, which cannot subscribe. The concern was that a server component might call a `SubCallback`
overload and silently render data that never updates. It cannot:

- A genuine subscription overload — `asset.isFrozen(cb)`, `account.getBalance(cb)` — **throws**
  `Subscriptions are not supported over http. SDK must be initialized with a ws connection in order
  to subscribe`.
- `network.getLatestBlock` has **no** callback overload, so passing one is a type error, caught at
  build.

Both failure modes are loud and early. No request to the SDK team.

### Noted, not requested: the major-only version gate

The SDK rejects a chain runtime only on a **major** spec change — `8.2` is accepted, `9.x` is not. The
REST API is the SDK server-side, so it inherits this exactly. Only the indexer is version-independent.

This is not a bug and not a request. It is the constraint that makes `(public)` indexer-primary
([ADR-0004](adr/0004-rest-vs-graphql-for-public-pages.md)) and one-deployment-per-network the model
([ADR-0010](adr/0010-the-network-model.md)). Recorded here so nobody re-derives it.

---

## REST API

<a id="g-rest-04"></a>
<a id="g-rest-09"></a>
### G-REST-09 — The REST API sends no CORS headers ⓘ Noted, not requested

- **Owner:** REST · **Priority: —** · **Status: Noted** — *we do not need this; recorded so nobody
  assumes otherwise*

`GET https://testnet-restapi.polymesh.live/network` returns `200` with **no
`Access-Control-Allow-Origin`**, and `OPTIONS` on the same path `404`s — there is no preflight
handler. So a browser cannot call the REST API at all. Verified 2026-08-23.

This is **consistent with the architecture rather than a problem for it**:
[ADR-0004](adr/0004-rest-vs-graphql-for-public-pages.md) makes REST a *server-side* tier for
`(public)` SSR, and every client-side read in `(app)` goes through the SDK or the indexer. Nothing we
build needs it.

It is recorded because it is easy to assume the opposite and lose an afternoon to it — the settings
screen was first written to read chain status over REST, which worked from Node and silently failed
in the browser. The status panel now states plainly that REST is a server-side tier rather than
showing a check that could only ever fail.

**If the REST team ever wants dApps calling it directly**, CORS is the thing that would enable it.
That is a product decision for them, not an ask from us.

### G-REST-04 — REST runs SDK ≤30 against a chain-v8 runtime

- **Owner:** REST · **Priority: P2** · **Status: Released** —
  [rest-api#369](https://github.com/PolymeshAssociation/polymesh-rest-api/pull/369) merged to `alpha`
  2026-08-24, released as **`v9.0.0-alpha.1`** the same day (a pre-release).

**Released is not deployed, and that is the whole of what is left.** The code exists; the hosted REST
the Portal actually reads does not have it yet.

Measured against `testnet-restapi.polymesh.live` on 2026-08-24, probing routes that exist only after
the v31 bump. NestJS answers a missing route with `Cannot GET <path>`, which distinguishes "no such
route" from "no such entity" — so this is a version probe, not a guess:

| Route | Live testnet REST |
|---|---|
| `GET /leg-validations` | **200** — and it accepts `fromAccount`/`toAccount`, so accounts are peer leg holders at REST too |
| `GET /accounts/:account/asset-balances`, `/collections` | **200** |
| `GET /assets/:asset/venue-filtering` | **200** |
| `GET /assets/:asset/transfer-restrictions/values` | **200** |
| `GET /instructions/:id/relock-status` | **404 `Cannot GET`** — absent |
| `GET /instructions/:id/legs/:legId/status` | **404 `Cannot GET`** — absent |

Both absentees are SDK-v31 additions (`getRelockStatus`, `getLegStatus`), so the deployment is on a
build from before the bump. Everything `(public)` SSR reads today is present and correct.

**One thing the release does not carry.** `v9.0.0-alpha.1` pins SDK **`31.0.0`**, not the Portal's
baseline `31.1.0-beta.3` (dist-tag `develop`). So REST has neither `initWasm` — irrelevant, the
Portal runs its own SDK and never REST's — nor **NFT-to-Account minting**: `IssueNftDto` in the
released spec carries only `options`, `signer` and `metadata`, with no `account` field. Any REST-side
NFT issuance is portfolio-only until REST takes a `31.1.x`.

- **Depends on:** nothing on our side. The remaining step is a deployment we do not control.

**What changed for us:** the priority drops from P1 to P2. The read paths `(public)` depends on were
already working (measured below), and the two v31-only routes are ones no built screen calls yet.
`P-XF-18` (instruction lock/unlock) is the row that cannot be built against live testnet until the
deployment lands.

**Measured against a local dev-env, 2026-08-22**, and consistent with the live probe above. The
published `polymeshassociation/polymesh-rest-api:latest` image bundles **SDK 30.0.0** and was
pointed at a **spec 8.1.0** chain. The blast radius is smaller
than "an older SDK against a v8 chain" suggests, and the distinction matters for Phase 1 planning:

| | Result |
|---|---|
| Every read route `(public)` SSR depends on | **Works.** `/assets/{id}`, `/holders`, `/documents`, `/compliance-requirements`, `/metadata`, `/identities/{did}`, `/identities/{did}/assets`, `/identities/{did}/portfolios`, `/network/latest-block` all return correct v8 data |
| Asset ID spelling | REST returns `assetId` in **UUID** form, matching our canonical choice ([ADR-0008](adr/0008-entity-model-and-the-entityinput-contract.md)) |
| Asset ID input | The `{assetId}` path segment accepts **UUID, hex *and* ticker** interchangeably |
| `POST /developer-testing/create-test-accounts` | **Fails** — `Internal: At least one identity was not found which should have been made` |

So the P1 remains right — but as a *write- and tooling-side* risk, not a read-side one. `(public)`
SSR is not blocked on the merge.

Two things fell out of the sweep that are ours to act on, not REST's:

1. **A ticker resolving in the `{assetId}` position is a hazard for us.** v8 deliberately moved off
   tickers, and a ticker is not stable. `packages/data` must only ever send the canonical UUID, so a
   mistake surfaces as a 404 rather than silently resolving to whatever holds that ticker today.
2. **The chain no longer has a `testUtils` pallet, and CDD providers now live under `didRegistrars`**
   (the old `cddServiceProviders` name is gone). Confirmed absent from spec-8.1.0 metadata. This is
   the likely cause of the `developer-testing` failure, and it is why `packages/fixtures`' seeder
   registers identities through the SDK rather than through REST.

<a id="g-rest-01"></a>
### G-REST-01 — Zero staking endpoints

- **Owner:** REST · **Priority: P2** · **Status: Open**
- **Affects:** all of `P-STK`

Measured, not assumed: the only `staking` string in the REST codebase is a balance field. There is no
staking controller.

Consequence for us: a **server-rendered** staking page cannot use REST at all. It must come from
`CHAIN` (which needs `G-SDK-06`) or from `GQL stakingEvents`. Every other `(public)` surface has a
REST path; staking is the one hole.

- **Closing it:** a staking controller mirroring `sdk.staking` — `GET /staking/era`,
  `GET /staking/validators`, `GET /accounts/:account/staking`. Reads only; the writes are client-side
  by our own rule and REST would not be used for them.

<a id="g-rest-02"></a>
### G-REST-02 — No corporate-ballot endpoints

- **Owner:** REST · **Priority: P3** · **Status: Open**

The SDK has `createBallot`, `castBallotVote`, `modifyBallot`, `removeBallot` and a `CorporateBallot`
entity. The chain has a 6-call `CorporateBallot` pallet. REST has nothing.

Combined with `G-IDX-02` (no indexer entity either), ballots are **client-SDK-only with no history and
no SSR**. Of the charter's Phase-5 additions this is the least supported.

<a id="g-rest-03"></a>
### G-REST-03 — Offerings are read-only

- **Owner:** REST · **Priority: P3** · **Status: Open**

`GET /assets/:asset/offerings` and `GET .../:id/investments`, nothing else. The SDK has
`launchOffering`, `investInOffering`, `closeOffering`, `toggleFreezeOffering`, `modifyOfferingTimes`,
`enableOffChainFundingForOfferings`.

Lower priority than it looks: those are all **writes**, and writes are client-side by architectural
rule regardless. The reads we need for SSR already exist.

---

## SubQuery indexer

<a id="g-idx-06"></a>
### G-IDX-06 — No allowance entity, so approvals have no history

- **Owner:** Indexer · **Priority: P3** · **Status: Open**
- **Use case:** the allowances screen (`P-PF-18`)

The SubQuery schema has `assetPreApprovals` and nothing for `asset.allowances` (introspected against
a live instance, 2026-08-23). So current state has to come from chain storage, and **there is no
history at all** — a holder cannot see when an approval was granted, by which key, or what it was
before it was changed.

Current state is workable from the chain ([G-SDK-14](#g-sdk-14)). History is not workable from
anywhere, and for a permission that lets someone else move your assets, "when did I grant this" is a
question worth being able to answer.

- **Closing it:** an `assetAllowance` entity keyed by `(assetId, owner, spender)` with the usual
  created/updated block, indexing `asset.approve`.

<a id="g-idx-01"></a>
### G-IDX-01 — `revive.ethTransact` is indexed with `address: null`

- **Owner:** Indexer · **Priority: P1** · **Status: Agreed** (2026-08-21)
- **Blocks:** `P-OV-08` for every Ethereum-derived account

The indexer records the `revive.ethTransact` extrinsic with a null address, so nothing can be
attributed to the Ethereum-derived Account that actually sent it. `Account.getTransactionHistory`
therefore **throws `NotSupported`** rather than returning an empty set — deliberately, because an
empty set would be indistinguishable from "no history" and read as a caller bug.

This is getting worse, not better: SDK 31.1 makes EVM signing first-class, so the share of users with
no visible history grows with adoption.

- **Closing it:** the Ethereum transaction payload carries the sender, so the indexer can recover the
  H160, derive `AccountId32 = <h160> ++ [0xEE; 12]`, and attribute the extrinsic to it. The address
  codec is already implemented twice — `eth-signing-manager`'s `ss58FromEthAddress` and the SDK's
  `utils/eth.ts` — with shared `DEV_ACCOUNTS` test vectors.
- **Until then:** the UI must render an explicit "history unavailable for Ethereum-derived keys"
  state. Never an empty table.

<a id="g-idx-02"></a>
### G-IDX-02 — No `ballot` entity

- **Owner:** Indexer · **Priority: P2** · **Status: Open**

Introspection of the live schema returns nothing matching `ballot` across 209 root query fields. No
ballot history, no vote records, no SSR. See also `G-REST-02`.

<a id="g-idx-03"></a>
### G-IDX-03 — No `checkpoint` or `checkpointSchedule` entities

- **Owner:** Indexer · **Priority: P2** · **Status: Open**

The charter's Phase-5 "Checkpoints & schedules" has SDK and REST support for current state but no
historical view. Checkpoints are inherently historical, so this is the awkward one.

<a id="g-idx-04"></a>
### G-IDX-04 — No generic `corporateAction` entity

- **Owner:** Indexer · **Priority: P2** · **Status: Open**

`distributions` and `distributionPayments` exist, so **dividend** corporate actions are covered.
Nothing else is — no `corporateAction`, no CA documents, no CA default config history.

The charter's "Corporate actions — create" (Phase 5) therefore gets no history beyond distributions.

<a id="g-idx-05"></a>
### G-IDX-05 — No `subsidy` / `relayer` entities

- **Owner:** Indexer · **Priority: P3** · **Status: Open**

The chain has an 8-call `Relayer` pallet and the SDK has the full subsidy surface. Phase-5 subsidies
would have no history.

### Noted, not requested: `blocks` is not a freshness signal

The `blocks` table only stores blocks that contained indexed events, so the newest row can be minutes
behind the chain head while the indexer is perfectly current. **Use `_metadata.lastProcessedHeight`.**

This cost us a wrong conclusion once. Recorded in
[ADR-0004](adr/0004-rest-vs-graphql-for-public-pages.md); repeated here because it is the kind of
thing a newcomer re-derives wrongly.

---

## Browser extension

<a id="g-ext-01"></a>
### G-EXT-01 — No confidential (ElGamal) key management

- **Owner:** Extension · **Priority: P3** · **Status: Open**

Confidential assets use a distinct key type the extension does not manage, which is one of the
reasons confidential is out of scope for v2.0
([ADR-0009](adr/0009-connector-optionality-custody-and-confidential.md)).

We are **not asking for this now**. It is recorded so that the connector interface keeps expressing a
second key type alongside the signing key — a near-zero-cost seam that means a future extension
release can be adopted without reworking the connector.

Do **not** add `polymesh-private-sdk` in the meantime: it pins polymesh-sdk 27 and `@polkadot/api`
11.2.1 against our 31 / 16.5.6, and it is the old private SDK.

---

## Chain changes absorbed

Capabilities the chain removed at v8. These are **not** requests — they are facts the Portal has
absorbed, listed so a parity gap is never mistaken for a regression we introduced.

| What | Consequence | Row |
|---|---|---|
| `Instruction.withdraw` has no v8 equivalent | Withdrawing an affirmation is gone; reject is the only path | `P-XF-16` |
| `Claims.getCddClaims` removed from SDK v31 | CDD claim surfaces through the identity view instead | `P-CLM-07` |
| `AccountManagement.subsidizeAccount` removed as a single call | Subsidy is now approve + accept, two transactions | `P-AUTH-14` |
| Child identities removed in v8 | Out of scope, permanently | — |

---

## Closed and withdrawn

Items stay here with the version that closed them — a closed item is the record of why a workaround
in the code can now be deleted. A **withdrawn** item is the record of a gap that turned out not to
exist, kept so the same wrong reasoning is not filed twice.

<a id="g-sdk-17"></a>
### G-SDK-17 — ~~No way to read an identity's CDD claim~~ ❌ Withdrawn

- **Owner:** SDK · **Priority: ~~P2~~** · **Status: Won't fix** — *withdrawn 2026-08-23, the day it
  was raised*

**The claim is meaningless, so the missing accessor is not a gap — it is the removal working.**
Customer-due-diligence claims stopped gating anything as of Polymesh v8: identity creation is
self-service (`self_register_did`, no registrar involved), and nothing downstream consults the claim.
The SDK dropping `Claims.getCddClaims` in v31 is that change reaching the client library.

Everything filed as evidence pointed at this and was read the wrong way round: the accessor was gone,
the indexer had no claims, and the fixture identities had none while issuing assets perfectly well.
Three independent signals that the thing does not matter, taken as three symptoms of a missing read.

`P-CLM-07` had already recorded it as **B — removed** at chain level. Its note said to "surface the
CDD claim through `P-OV-07`", which was read as *find another way to read it* rather than *it is not
a thing any more*; that note is corrected.

**Kept rather than deleted** because "the SDK cannot read X" is an easy shape to file again, and the
answer here is that nobody should want to.

<a id="g-sdk-10"></a>
### G-SDK-10 — ~~No way to ask whether self-registering a DID is permitted~~ ❌ Withdrawn

- **Owner:** SDK · **Priority: ~~P3~~** · **Status: Won't fix** — *withdrawn 2026-08-22, the day it
  was raised, before it was taken to the SDK team*

**The premise was wrong.** This asked for a capability probe answering "will this chain accept a
self-registered DID". There is nothing to probe: the Portal only ever connects to chains the SDK
supports — v8 and up, since the SDK's chain gate is major-only — and `identity.self_register_did` is
available on all of them. Self-registration is **always** possible.

The measurement that led here was sound and is kept, because it is the evidence: `self_register_did`
is present in mainnet, testnet and dev-chain metadata alike (checked 2026-08-22), and
`identity.initialPOLYX` is `0` on mainnet against `100000000000` on testnet. What was wrong was
reading the identical metadata as *ambiguity*. It is not ambiguous — it is uniform, because the
capability is uniform.

**The real constraint is funding, and it needs no upstream change.** A key registers its own DID and
pays the fee, so the only question is whether it holds enough POLYX. That is a balance, and
`transaction.getTotalFees()` already returns the fee and the paying account's balance together — one
call, an exact answer, no new API. `packages/chain`'s `planIdentityRegistration` is built on it.

Where a new key cannot pay — every key on a test chain — funding is a **deployment capability**, not
a chain one: a service that registers and funds, configured per deployment as `network.onboarding`.
v1 ran exactly such a worker for testnet. For local dev chains, `yarn seed` funds the fixture
accounts from Alice; a registrar-based path there is a seeder concern, and the REST endpoint that
would have served it is [G-REST-08](#g-rest-08).

**Kept rather than deleted** because the wrong version of this reasoning is easy to re-derive: the
next person to notice that the metadata looks the same on every network should find this here, not
file it again.

<a id="g-sdk-06"></a>
### G-SDK-06 — Read-only connect failed where WASM compilation is forbidden ✅

- **Owner:** SDK · **Was P1** · **Closed in `31.1.0-beta.3`** (2026-08-21) —
  [sdk#1657](https://github.com/PolymeshAssociation/polymesh-sdk/pull/1657)

`ApiPromise` gated its `ready` event on `cryptoWaitReady()`, which resolves `false` rather than
rejecting where WASM is forbidden — so `Polymesh.connect` hung forever with nothing to trace. The fix
adds `polkadot.initWasm`, initializes the crypto backend when a signing manager is attached, and drops
`cross-fetch`.

**Verified in the published package:** `initWasm?: boolean` in `api/client/types.d.ts`.

**What this unlocks:** the server-side SDK fallback in
[ADR-0003](adr/0003-sdk-server-side-in-the-worker-runtime.md) is now real rather than conditional —
read-only SDK over `HttpProvider` connects in 3005ms in workerd. It stays a *fallback*: REST costs
4.5× less CPU per render and remains the default for `(public)` SSR.

**Code to delete:** the `node_modules` patches in the spike apps that reproduced this PR by hand.

<a id="g-sdk-07"></a>
### G-SDK-07 — NFTs could only be minted to a portfolio, not an Account ✅

- **Owner:** SDK · **Was P2** · **Closed in `31.1.0-beta.3`** (2026-08-21) —
  [sdk#1656](https://github.com/PolymeshAssociation/polymesh-sdk/pull/1656)
- **Unblocks:** the Account path of `P-AM-14`

`IssueNftParams` and `BatchIssueNftParams` now carry an optional `account`, mutually exclusive with
`portfolioId`, mirroring what `FungibleAsset.issue` already offered. Omitting both is unchanged — the
NFT goes to the signing Identity's default portfolio.

**Verified in the published package:** `account?: string` on both types, with the mutual-exclusion
note in the doc comment.


<a id="g-idx-07"></a>

### G-IDX-07 — the indexer's authorization payload disagrees with the chain

- **Owner:** Indexer · **Priority: P1** · **Status: Open**
- **Use case:** the authorizations list and its detail rail (`P-AUTH-01`, `P-UX-02`)

`authorizations.data` stores what the authorization was **created** with. The chain migrated its
stored payloads to asset ids; the indexer did not. So for anything issued before the asset-id
migration the two now name different things:

| Authorization 54,631 | Value |
|---|---|
| Indexer `data` | `0x543120…` — the ticker `T1` |
| Chain `authorizationData.TransferAssetOwnership` | `0x7edf86b7e651823cb21c2574e61c6ff3` — an asset id |

**This is worse than staleness, because the obvious repair is wrong.** Resolving `T1` to the asset
it names today gives `9d2c625f-0a46-…` — a *different asset* from the one the chain would transfer,
because the ticker was detached and reattached in between. A screen that resolved the ticker would
have told a user they were accepting ownership of the wrong asset. Verified on live testnet
2026-08-24.

**Ask:** migrate the stored payload alongside the chain, or expose the migrated form as a second
field so a consumer can tell which era a row is from.

**What we do meanwhile.** The subject is read from the **chain** (`AuthorizationRequest.data`) for
every row the chain confirms, and the indexer payload is used only where the chain could not be
reached — rendered as the historical ticker, explicitly not resolved, and labelled as unconfirmed.
See `packages/chain/src/domains/authorization-subject.ts`.

**Related, and not a gap:** the chain does **not** check that an asset exists when an authorization
is issued. Authorization 54,631 names an id no asset has and is still `Pending`; it can never be
accepted. That is chain behaviour we design around, not something to file — the list checks
existence for the assets on screen and disables Accept with the reason.

<a id="g-sdk-20"></a>

### G-IDX-08 — no balance or holding entity, so a portfolio cannot be counted from the index

- **Owner:** Indexer · **Priority: P2** · **Status: Open**
- **Use case:** the Holdings holder picker (`P-PF-01`, `P-PF-10`, `P-UX-03`)

The `Portfolio` entity carries its identity, its name, its custodian and its **history** — checked
against the live schema on 2026-08-24, it exposes `assetTransactionsBy{From,To}PortfolioId`,
`portfolioMovementsBy{From,To}Id`, `distributions` and `stos`. It carries **nothing about what is in
it now**: no balance rows, no holder count, no asset count.

So a screen that lists portfolios can list them, page them, order them and search them from the
index, and cannot say what any of them holds without one chain read per portfolio. For the audited
identity that is **536 chain reads** to fill in a count.

**Ask:** a `portfolioAsset` (or `assetHolder`) entity keyed by `(portfolioId, assetId)` carrying the
current balance, maintained the way the chain's own `portfolioAssetBalances` map is. Even a bare
`assetCount` on `Portfolio` would serve the picker.

**What we do meanwhile.** The picker shows **no per-holder count**. The canvas's chip carries one
(`design/Holdings.src.html`, `{{ h.n }}`), and it is deliberately omitted rather than approximated:
a count that is right for six previewed portfolios and absent for the other 530 is worse than no
count at all, because the reader cannot tell which they are looking at.

**Not blocked by this:** the **Last movement** column. History is exactly what the entity does carry,
so `packages/data/src/indexer/last-movement.ts` reads it — one alias per asset, `first: 1` each, one
round trip. Verified live: `4d4c734d-…` in the audited identity's default portfolio last moved
2021-11-05T13:56:36Z.

<a id="g-idx-09"></a>

### G-IDX-09 — numeric ids are strings, so ordering by id is alphabetical

- **Owner:** Indexer · **Priority: P2** · **Status: Open**
- **Use case:** every list ordered by a chain-assigned sequence (`P-XF-01`, `P-AUTH-01`)

`Instruction.id` is the chain's own sequence — 1, 2, 3 … 14,712 — and the indexer stores it as a
`String`. So `orderBy: [ID_DESC]` sorts it as text. Measured against the live testnet indexer on
2026-08-24, across 14,712 instructions:

```
orderBy: [ID_DESC]                → 9999, 9998, 9997, 9996, 9995, 9994
orderBy: [CREATED_EVENT_ID_DESC]  → 14712, 14711, 14710, 14709, 14708, 14707
```

The failure is quiet and it is the worst kind: the list is *ordered*, it is *stable*, it pages
correctly, and it is *wrong*. "Newest first" puts the newest settlement about a hundred and ninety
pages in, and nothing on screen suggests anything is amiss. The same shape applies anywhere a
numeric identifier is stored as text.

**Ask:** either store chain-assigned numeric ids as an integer type, or zero-pad them the way
`createdBlockId` and `createdEventId` already are (`0025563903`, `0025563903/0000000002`) so that a
lexicographic sort is also a numeric one.

**What we do meanwhile.** Instruction lists order by **`CREATED_EVENT_ID_*`**, not by id. It is
zero-padded on both halves, so it sorts correctly as text; it is a *total* order, unlike
`CREATED_BLOCK_ID_*` where several instructions can share a block; and because ids are assigned in
creation order it is also numeric id order — which is what a reader sorting the "Instruction"
column believes they are asking for. See `packages/data/src/indexer/instructions.ts`.

### G-SDK-24 — the permissionable-transaction map is hand-maintained, and nothing detects it going stale

- **Owner:** SDK · **Priority: P3** · **Status: Agreed** — option 2 scheduled. **Option 1 is not
  buildable**, for the reason we identified ourselves: nothing in metadata marks a call as
  permissionable, so a runtime-derived set needs an upstream chain change. What is coming instead:
  the spec version the map was curated against exported next to `SUPPORTED_SPEC_VERSION_RANGE`,
  `isPermissionable(tag)`, and **a CI check that reconciles every curated tag against
  `@polymeshassociation/polymesh-types` metadata** — which is the reconciliation we built in
  `packages/chain/src/domains/permissionable.ts`, better run once upstream than in every consumer.
  **Revisit on release:** ours can then be a thin consumer of `isPermissionable` rather than its own
  reconciliation, and the "0 missing" count on screen becomes a spec-version comparison instead.
- **Use case:** the secondary-key permissions editor (`P-KEY-05`)

A secondary key's transaction permission is only consulted where an extrinsic asks for it. The
runtime funnels that through `pallet_permissions::ensure_call_permissions`, reached from
`Identity::ensure_perms` / `ensure_origin_call_permissions` / `ExternalAgents::ensure_asset_perms`;
an extrinsic whose body calls plain `ensure_signed` never consults it. Whole pallets have no check
anywhere — `utility`, `relayer`, `protocolFee`, `validators`, the `group` instances — and neither
does any Substrate pallet in the runtime (`balances`, `staking`, `session`, `scheduler`, `system`,
`preimage`, `indices`, `revive`); the PolymeshAssociation fork of polkadot-sdk adds no hook to them.

So **enumeration from metadata is the wrong source for a permissions UI**: live testnet has 390
calls, and permissioning most of them writes something the chain stores, displays back and never
consults. The SDK already solves this — `TX_GROUP_TO_TAGS_MAP` is **135 tags across 14 pallets in 25
job groups**, which is a curated list of what is actually governed, in units a person administering
a key thinks in. That is the right thing and this request is not to replace it.

The gap is that it is **hand-maintained in a released package, against a chain that upgrades**. A
tag renamed or removed by a runtime upgrade stays in the map until somebody notices; a newly
permissionable extrinsic is absent until somebody adds it. Neither is detectable from the SDK's own
API — there is no version marker, no "this map was built for spec X", and no way to ask whether an
arbitrary tag is permissionable.

**Ask:** one of —

1. expose `isPermissionable(tag)` or the permissionable set as a **runtime-derived** value, so the
   answer comes from the chain the session is connected to rather than the package version; or
2. stamp `TX_GROUP_TO_TAGS_MAP` with the spec version it was generated against, so a caller can say
   "this list predates your runtime" instead of silently offering the wrong set; or
3. generate it from the runtime at build time and publish the generator, so downstream can re-run it.

The underlying fix is upstream of the SDK: the permission check is a convention inside each
extrinsic body rather than an attribute on the call, so nothing in metadata marks a call as
permissionable. An attribute the runtime emits would make all three of the above fall out.

**What we do meanwhile.** `packages/chain/src/domains/permissionable.ts` builds the picker from the
SDK's curated map and reconciles every tag against the connected runtime's metadata
(`raw/extrinsics.ts`, a walk over data `ApiPromise` already holds). A curated tag the runtime does
not have is dropped and **counted on screen**, so the SDK falling behind becomes a visible number
rather than a permission that cannot be granted. Measured against live testnet (spec `8001000`) on
2026-08-25: 135 curated tags, **0 missing** — in step today, and the check is what will say so
tomorrow. The reverse case is surfaced too: a permission the key already holds that the map does not
name is left exactly as it is rather than dropped on the next save.

### G-SDK-23 — no batch-size guidance, so every caller guesses

- **Owner:** SDK · **Priority: P2** · **Status: Open**
- **Use case:** bulk accept/reject of authorizations (`P-UX-03`, `P-XF-12`, [audit A-06](audit-2026-08-23.md))

`sdk.createTransactionBatch` wraps `utility.batch`, which is bounded by **block weight** rather than
by a count. The SDK exposes no general limit — the only related constant is
`MAX_BATCH_SIZE_SUPPORTING_SUBSIDY = 7`, which is about subsidised keys and does not answer this.

So a caller that wants to clear a 1,006-item backlog has to pick a number, and the failure mode of
picking it too high is the worst one available: the user selects rows, reads a count, signs, and the
chain rejects the batch for weight afterwards.

**Correction, 2026-08-27 — the SDK does *not* already know this.** The only weight-ish read in the
codebase is `composedTx.paymentInfo(signingAddress)` inside `getTotalFees`; it is lazy, it discards
everything but `partialFee`, and it costs **one RPC round trip per transaction**. So the ask is not
"expose a number the SDK is holding" but "provide an async planner", and the answer will be
documented as costing N round trips. The SDK's plan is a `getWeight()` on
`PolymeshTransactionBase` that keeps `paymentInfo`'s `weight`, plus `sdk.planBatch(transactions)`
against `consts.system.blockWeights`. Our original ask, with the wrong premise, follows.

**Ask:** either a documented per-call weight, or a helper that takes a list of prepared transactions
and returns how many fit in a block — the SDK already knows each transaction's weight at
preparation.

**What we do meanwhile.** `packages/chain/src/domains/identity.ts` caps at a conservative
`BATCH_LIMIT = 50` and the UI **states the count before the wallet opens**, refusing a larger
selection with the reason rather than truncating it silently. Each transaction is prepared
individually, so one that cannot be prepared is dropped and reported instead of failing the batch.

### G-SDK-20 — unbounded storage scans behind plain-array reads

- **Owner:** SDK · **Priority: P2** · **Status: Open**
- **Use case:** holdings, venue signers, subsidies (`P-PF-01`, `P-XF-05`)

Seven reads iterate `.entries()` with no page size and no cap:
`account.getAssetBalances`, `account.getCollections`, `account.getOffChainReceipts`,
`portfolio.getAssetBalances`, `portfolio.getCollections`, `venue.getAllowedSigners`,
`subsidies.getBeneficiaries`. For most the practical bound is small. The balances and collections
pair is not: there is one entry per asset or collection **ever held**, which is the same set
[G-SDK-12](#g-sdk-12) is about.

**Ask:** `PaginationOptions` on the two holdings reads at minimum, consistent with the rest of the
paginated surface.

<a id="g-sdk-21"></a>

### G-SDK-21 — middleware is mandatory for settlement status and MultiSig detail

- **Owner:** SDK · **Priority: P2** · **Status: split, 2026-08-27** — **MultiSig half: Won't fix,
  not buildable. Settlement half: Agreed, small.**

**MultiSig — the chain cannot answer it, and this is the chain's gap, not the SDK's.**
`MultiSigProposal.details()` is *already* chain-only; only `votes()` touches middleware. A fallback
for `votes()` cannot exist: `pallet_multisig` writes `Votes::insert((multisig, proposal_id),
&signer, true)` in **both** `unsafe_approve` and `unsafe_reject`, so the stored bool means "has
voted", not how — and no block identifier is kept. `MultiSigProposalVote` requires `action`, which
could only be fabricated. `details().voted` already *is* the complete chain-side answer.

**Settlement — nearly free.** `Instruction.getStatus()` already reads the chain first via
`isPending()`, and `settlement.instructionStatuses` carries the full terminal status (`Failed`,
`Rejected`, `Success`, `LockedForExecution`). It throws only because
`InstructionStatusResult.eventIdentifier` is non-optional and the block/event index is the one part
the chain does not keep. Fix is to widen it to `| null` — a type break, so a major — or add a
sibling method. Our original text follows.
- **Use case:** any degraded-mode or `(public)` rendering of settlements and MultiSig

`Instruction.getStatus()` throws `DataUnavailable` when the middleware cannot answer, and
`MultiSigProposal.details()` / `.votes()` are middleware-only with **no chain fallback at all**.
Every neighbouring read is hybrid — `instruction.details()`, `getAffirmations()`, `getLegs()` all
branch on `isMiddlewareAvailable()` — so these two are the exception, and they are the two a
settlement screen cannot do without.

This matters to us specifically because ADR-0004 makes the indexer the tier that survives a chain
major bump **and** the tier most likely to lag. A surface that degrades everywhere except its status
column has not degraded.

**Ask:** a chain fallback for both, or a documented `DataUnavailable` contract that a caller can
branch on without catching by message.

<a id="g-sdk-22"></a>

### G-SDK-22 — ~~`Assets.get()` cannot see an unnamed asset~~ — premise wrong

- **Owner:** SDK · **Priority: ~~P3~~** · **Status: Closed** — as a round-trip saving, not as the
  bug we filed.

**The omission we reported cannot happen.** `base_create_asset` inserts `Assets` and `AssetNames` in
the same call and `asset_name` is a required parameter, not an `Option` — so no asset can lack a
name, and our "4 of 18 rows carry neither name nor ticker" was rows with no **ticker**, read from the
indexer, which is a different field. The paging change shipped anyway because `asset.assets` can be
paged directly, dropping the `.multi()` round trip.

**One behaviour note that matters if we ever page assets from the SDK:** `next` is a storage key, so
a cursor persisted across this change points into the wrong map. We page by offset from the indexer
and persist nothing, so this does not reach us. Original text below.

`Assets.get(paginationOpts?)` pages `asset.assetNames` (`dist/api/client/Assets.js`), so an asset
whose name was never set is not enumerated at all. Name is optional on chain, and 4 of 18 rows on a
live testnet account carry neither name nor ticker — so this is not a corner case.

Only bites if `(app)` ever enumerates assets from the SDK rather than the indexer, which is why it
is P3 rather than higher. Recorded so nobody discovers it by shipping a list that is quietly short.
