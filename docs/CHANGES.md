# Revision supplement — 2026-09-01

Everything that changed in the indexer review on 2026-09-01, and why. Read this if you read the review before that date; it is a quick reference, not a replacement for the documents it summarises.

**Base moved** from `7fbb8bb` to `alpha@0f4f337` — nine commits, including PRs [#342](https://github.com/PolymeshAssociation/polymesh-subquery/pull/342) and [#343](https://github.com/PolymeshAssociation/polymesh-subquery/pull/343).

Claims below carry the same tags as the review: **[V]** verified, **[I]** inference.

---

## At a glance

| | Before | After |
|---|---|---|
| Entities | 67 | **69** |
| Confirmed defects | A1–A12 | **A1–A16** |
| Fragile patterns | B1–B8 | **B1–B9** |
| Decisions | D1–D7 | **D1–D12** |
| Implementation plans | 00–09 | **00–12** |
| Open blocking questions | none | none |
| Open *decisions* | none | **two** — epoch-integer timestamps; staking history in scope |

**No code changed in this revision.** Plan [12](./implementation/12-types-and-ci.md) was built and run in full locally — green end to end — and then reverted, so its costs are measured rather than estimated. The tree holds documentation only.

**Three new plans:** [10 — partial index](./implementation/10-partial-index.md), [11 — throughput](./implementation/11-throughput.md), [12 — types and CI](./implementation/12-types-and-ci.md).

**One thing the review said that was wrong and is now corrected:** `entity-review.md` claimed `Extrinsic` and `Event` had no indexes on their filter columns. `architecture-review.md` §4.1 had already retracted that — the indexes exist in `db/compat.sql` **[V]** — but the entity table had not been updated, so the two documents disagreed. They now agree, and the finding is *two sources of truth*, not missing indexes.

---

## 1. Brought forward from the rebase

### 1.1 Two open items shipped

| Item | Closed by | What it means for the review |
|---|---|---|
| `revive.ethTransact` recorded with `address: null`, so nothing attributed to an Ethereum-derived account | **#342** | Sender is recovered from the RLP payload, mapped to the `0xEE`-padded `AccountId32`. Two new entities, plus `Account.keyType`/`evmAddress` and `Extrinsic.ethAddress`/`ethTxHash`. A backfill covers history. |
| `authorizations.data` keeps the pre-migration payload, naming a ticker where the chain names an asset id | **#343** | Repaired forward at the upgrade hook and by backfill. Worth knowing *why* the obvious repair was wrong: resolving the stored ticker to the asset it names **today** can point at a different asset, because a ticker can be unlinked and relinked in between. The fix derives the id deterministically instead — `AssetId::from(ticker)` = `blake2_128(("legacy_ticker", ticker))` normalised to a v8 UUID — with no chain read at all. |

Both are recorded in [`reference/consumer-queries.md`](./reference/consumer-queries.md) §9.6.

### 1.2 Schema and counts

- **`EvmTransaction`** and **`EvmAccountMapping`** added; both judged ✅ in [`entity-review.md`](./entity-review.md) §1. They follow the settlement domain's conventions — docstrings, explicit enums, a relation to the entity they extend — which is the pattern the review recommends everywhere else.
- Entity count 67 → **69** in `README.md`, `entity-review.md`, `architecture-review.md` §1 and `consumer-queries.md` §1/§4.
- `genesisHandler` now also seeds `EvmAccountMapping` from `revive.originalAccount`. **The "genesis seeds no balances" finding is unchanged and still a hard prerequisite for the POLYX ledger** — that gap was not closed.
- `tsconfig.json` gained `ts-node.files`, so scripts run through ts-node see SubQuery's injected globals. Relevant to plan [12](./implementation/12-types-and-ci.md): `scripts/**` is still in no tsconfig's `include`, so nothing type-checks it.

---

## 2. New findings

Six, four of which became defects. Each was verified by running something, not by reading alone.

### 2.1 A13 — internal paging is not deterministic **[V]**

`getPaginatedData` sets `orderBy` to the **column it is filtering on** ([`common.ts:325`](../src/utils/common.ts#L325)), so every row in the result set holds an identical value and the order is not total. Offset paging over it can repeat a row and skip another.

Three call sites, each acting on the set it reads: settlement legs, agent-group memberships, transfer compliances.

**Why it matters more than its size:** this is the third instance of one defect. `createdBlockId` alone (the reason D4 exists), this, and A14 below are all *"an ordering that is not total makes paging repeat and skip rows."* Stating it once as a rule is more useful than three fixes, so it is now in `architecture-review.md` §9 and in the shared conventions.

→ [`00-quick-fixes.md`](./implementation/00-quick-fixes.md) A13 (one-line fix), [`11-throughput.md`](./implementation/11-throughput.md) §11.3 (why it was found there)

### 2.2 A14 — `Instruction.id` sorts alphabetically **[V]**

The chain's numeric instruction sequence is stored as a `String`, so `orderBy: [ID_DESC]` ranks `9999` above `14712`. The list is ordered, stable, pages correctly — and puts the newest settlement roughly a hundred and ninety pages in, with nothing to indicate it.

**D12** extends D4 from composite ids to bare numeric ones: chain-assigned numeric ids get zero-padded. The id itself changes with the D5 rebuild; the docstring can land now.

### 2.3 A15 — pre-v8 staking rewards are unattributable **[V]**

`mapStakingEvent.ts` records `rewardDestination: 'LegacyUnknown'` for every pre-8.x reward, because the event carried only the stash. Where a staker set a payee other than their stash, the index cannot say which account received the POLYX. The v8 path is correct.

`LegacyUnknown` is an honest placeholder rather than a wrong value — this is a **coverage** gap, not a correctness one. It matters because these rows are used for accounting, where "looks complete and is not" is the expensive failure.

**Recoverable two ways, and they are not equivalent.** (a) read `staking.payee(stash)` at the reward block — authoritative, one read per reward during the replay. (b) derive a payee timeline from extrinsics — **zero** chain reads, since `staking.bond(value, payee)`, `setPayee` and `updatePayee` carry it as call arguments, and `set_payee`/`update_payee` are already in `CallIdEnum` **[V]**.

**(b) has no event to hang off.** Verified against v8 metadata: the staking pallet emits **19 events and not one of them is payee-related** **[V]**. So the timeline must be reconstructed from calls, which brings four gaps — nested `utility.batch` calls, `setPayee` being signed by the *controller* while rewards key on the *stash*, genesis stakers having no `bond` extrinsic at all, and `updatePayee` being a silent v8 rewrite of the same class as A11.

Recommendation recorded: **(a) for ledger correctness, (b) only if staking history becomes a domain in its own right** — which is now an open decision (§3.0).

**Unmeasured**, deliberately: how often the payee differed from the stash. Decide on that number, not on principle.

### 2.4 A16 — timestamps carry no timezone **[V]**

27 `Date` fields serialize as `"2021-11-05T13:56:36"`, which most runtimes parse as **local** time — so the value shifts by the reader's own offset, differently for different readers, with no error.

**D8:** `timestamptz`, so the wire form carries `+00:00`. No schema field changes, no new fields.

### 2.5 B9 — module-level mutable state on the event path **[V]**

`handleEvent` gates the `Block` write and `handleExtrinsic` on module-level `lastBlockHash`/`lastEventIdx`. Same class as A5, on a far hotter path.

Two things follow, and only one is a defect:

- **The `blocks` table is sparse** — `mapBlock` runs from `handleEvent`, not a block handler, so a block with no handled event gets no row. `MAX(block_id)` is **not** a freshness signal; `_metadata.lastProcessedHeight` is. This is a docstring, not a code change — writing a row per block would be correct-looking and expensive.
- **[I]** Under `--workers` each thread holds its own copy. Not reproduced; workers are currently off. Resolve with A5.

### 2.6 The `relayer` pallet has no entity and no handler **[V]**

Eight calls in `CallIdEnum`, zero coverage. A subsidy is a standing financial relationship between two identities and its history is exactly what this index is good at. Smallest remaining pallet-shaped gap; purely additive.

→ [`entity-review.md`](./entity-review.md) §15

---

## 3. Feedback incorporated

Six items raised for consideration. What was done with each, including where the answer was "already covered".

### 3.0 New open decision: is staking history in scope?

Raised while working through A15. Every route to attributing a pre-v8 reward is a step toward a `StakingPosition` / `Nomination` / `Validator` / `Era` model that does not exist (`staking` is **8/32** handled), and it is fair to ask whether that is this index's job at all or whether it should stay focused on the securities domain.

The plans currently assume a **middle line** — index enough staking to make the POLYX ledger attributable (reward destination, `PayoutStarted` for `eraIndex`, bonded/unbonded transitions), and treat validator/nomination/era modelling as a separate later decision. That was an assumption, not a decision. It is now recorded as one in [`README.md`](./README.md) "Questions still open", with the argument both ways in plan [02](./implementation/02-polyx-ledger.md), and it should be settled before plan [07](./implementation/07-staking.md) is sized.

### 3.1 `START_BLOCK` does not work → D9, plan [10](./implementation/10-partial-index.md)

**Two independent failures [V]**, and the second is the interesting one:

1. The genesis datasource declares `[1,1]` alongside `[startBlock,∞)`, a range the node will not cover. One conditional fixes it, and `handleGenesis` is not idempotent so it cannot simply be widened.
2. State is initialised empty, so every handler that modifies an existing entity meets an empty database.

Failure 2 splits into a **hard stall** (`getAsset` throws, the block retries forever — loud, therefore safe) and a **silent wrong total** (`totalSupply += n` on a fresh `Asset` yields the delta since the start block, presented as a total — quiet, therefore not).

**That distinction is why "make every write an upsert" was rejected**: it removes the stall and keeps the wrong number. D9 seeds from chain storage at the start block instead, records what was seeded in an `IndexOrigin` entity, and makes accumulating writes *refuse* to run over an unseeded domain. §8 principle 2 on a new axis — unknown is recorded, never guessed.

Two things make it cheaper than it sounds: `api.query` inside a handler already targets the block being indexed **[V]**, so a handler bound to `[startBlock, startBlock]` reads storage as of that block with no `.at`; and `genesisHandler` already implements the shape for six domains. The work is extraction into `src/seed/`, shared with the genesis path, plus the domains genesis skips — **notably balances**, which the POLYX plan needs regardless.

Sequenced **last** for that reason: doing it before plans 02 and 03 means writing the seeders twice.

**The `project.ts` conditional is independent and should land on its own.** It already exists as a local patch, proven by starting a testnet index at block 24,928,521, and plan [10](./implementation/10-partial-index.md) now carries it verbatim rather than paraphrased. It unblocks development against a recent block without waiting for any seeding work.

### 3.2 POLYX accounting fidelity → D11, plan [02](./implementation/02-polyx-ledger.md)

The concern was right and it had a verifiable instance (A15). One suspected instance remains **unverified** and is recorded as such rather than asserted: **transaction-fee attribution across runtime versions** — splitting a fee between validator, treasury and payer was derived rather than emitted on older runtimes, so the fee rows may not account for the whole fee at every spec version. It goes into the entity-by-entity version sweep.

**A reconciliation harness is now a deliverable of plan 02, not a follow-up.** Method, in brief:

- **Sample, don't enumerate** — accounts stratified by activity, oversampling every account appearing in `BalanceSet`, `DustLost`, `Slashed` or a pre-v8 `Reward`, because that is where the suspected gaps live.
- **Compare at version boundaries** — one block either side of each spec transition. A drift that appears on only one side names the runtime that caused it.
- **Compare `free`, `reserved` and `frozen` independently.** Comparing only the total hides a pair of offsetting errors, which is exactly what a pool-mapping mistake produces.
- **Classify, don't count.** Constant drift from a block is one missed event; growing drift is a mis-signed one; `reserved`-only drift is a pool mapping error. The taxonomy is the output.

Access is public endpoints — enough for a sampled comparison at chosen blocks, not for a full-history sweep, and rate-limited. The harness is designed to resume and to run unchanged against a local archive node if one appears.

### 3.3 Timestamps → D8 decided, the epoch integer left **open**

`timestamptz` is decided. The **epoch-integer question is deliberately not answered** — it is the only open decision in the review, and the arguments do not obviously resolve. Written up in full at `architecture-review.md` §10.2; the short version:

| For | Against |
|---|---|
| An integer cannot be misread as local time | `timestamptz` already fixes the stated defect; the integer is convenience on a correct value |
| Cheaper comparison and range filtering | **Ordering is already solved, and not by time** — every event in a block shares one timestamp, so an epoch column is not the ordering key and inviting its use as one is a hazard |
| Survives JSON, which has no date type | Two representations of one fact must be kept in agreement |
| Arithmetic is direct | 8 bytes plus an index per entity, on the fastest-growing tables, on a write path already under throughput pressure |

**A middle position** is noted: add it only to the ledger entities where time-range filtering dominates, leaving the other 25 date fields as `timestamptz` alone — cost proportional to benefit, at the price of an inconsistent schema.

The decision needs a consumer, not an argument. In the meantime the shared conventions say: **do not add one to a new entity until it is decided** — adding it later is a mechanical one-column change; removing it is not.

One implementation detail worth not losing: the conversion clause is `USING <col> AT TIME ZONE 'UTC'`. Without it Postgres reads existing values in the **server's** zone and bakes in the very error being fixed.

### 3.4 Slow blocks → plan [11](./implementation/11-throughput.md), and §13

Four cost sources, from code reading. The first is the answer to the NFT case:

1. **`NftHolder.nftIds` is an unbounded array rewritten in full on every mutation**, multiplied by historical mode (D3) where each `save()` **inserts a new row version carrying the whole array**.

   **Now measured on a named block, not inferred.** Testnet **15,391,572** (2024-09-13) redeems **399** NFTs, and the chain emits **one event per NFT** rather than one per batch **[V]**. Each event runs a full `filter` over holder `0x84415cd92b0e…`'s array — still **2,724** ids today, so ~3,123 at the start of that block — then rewrites it whole:

   ```
   ≈ 1.16M filter comparisons + 1.16M integers serialised
   across 399 row versions, to delete 399 ids
   ```

   Roughly three thousand integers written per integer deleted.
2. **`getOrCreateAccount` reads the chain on every miss and caches nothing on a negative** — it returns `undefined` without writing anything, so the next event referencing that address reads again. Reached **twice per asset movement** on v8.
3. Per-row read-modify-write where `bulkCreate`/`bulkUpdate` exist — used in exactly one place.
4. B9's module-level gating.

**The most useful conclusion is not a fix, it is a reframing.** The row-per-NFT `Nft` entity in plan [03](./implementation/03-holdings-nfts.md) was justified on *addressability*; it turns out to be the throughput fix too. And under historical state, *row count* is the wrong thing to optimise and *mutation count* is the right one — many small immutable rows beat few rows rewritten often. That inverts the usual instinct and it independently supports the entry-centric ledger.

Two rules adopted: **a chain read in a handler must justify itself in a comment at the call site** (each one is standing in for state the index does not hold — i.e. a modelling gap), and **an array field is a liability proportional to length × mutations**.

**Replay fixtures are now named**, both verified against the live testnet middleware: **15,391,572** (redemption, worst case — the array is at its longest and every event rewrites it) and **13,528,440+** (**4,990** `IssuedNFT` over ~200 blocks, 20–30 per block — the growth side).

**No wall-clock number is claimed.** The mechanism is established and the arithmetic is exact, but nothing has been profiled and the mainnet equivalents of those blocks are not yet identified.

### 3.5 Filtering, indexing and linking → `architecture-review.md` §14

Written as a schema-review discipline rather than a list, because the four goals compete:

- **Relations** — the recurring smell is a `String` holding an id another entity is keyed by (`TrustedClaimIssuer.issuer`, `MultiSigAdmin.identityId`, `AgentGroupMembership.member`, `ProposalVote.account`, `MultiSig.address`, `Investment.offeringAssetId` **[V]**). Each is a join the schema knows about and refuses to express. `InstructionParty.identity: String!` is the counter-example that proves the rule — a documented choice, because an off-chain leg may name a party with no DID.
- **Indexes** — two sources of truth is the problem, not the count. An index is added from a measured access pattern, because under D3 every write is an insert.
- **Filtering** — the capability usually needed is not a new column but an existing one being filterable. Two consumer-observed gaps are recorded in `consumer-queries.md` §9: an authorization to a key with **no identity yet** has a null `toId` and is unfindable by DID (`toKey` is the **hex** public key, not SS58 — an encoding difference that returns zero rows rather than an error), and a portfolio's current contents are unreadable from the index at all.
- **Bloat** — prefer, in order: make an existing column filterable, denormalise one field, add a `@jsonField` where the value is read whole, add a table. `Claim.scope` versus the separate `ClaimScope` entity is the case where the schema does the last two for the same fact.

### 3.6 TypeScript types → D10, plan [12](./implementation/12-types-and-ci.md)

**Prototyped in full, then reverted.** Everything below was verified by building it: lint, typecheck, build and 198 unit tests green, 0 type errors, bundle loading all 188 handlers **[V]**. The code was then backed out — this revision ships documentation only — so the plan is costed from observation rather than estimate.

**A first pass measured "3 errors" using `--skipLibCheck`. That was the wrong measurement.** Type-checking *without* it shows the naive one-line version produces **454** errors in four classes, and each needs a different answer:

| Class | Count | Answer |
|---|---|---|
| TS2305/TS2724 — `augment-api-*` imports Polymesh types from `@polkadot/types/lookup` that nothing put there | **277** | Import `types-lookup` **before** `augment-api`. Removes 274 |
| TS2717 — `@polkadot/api-augment` and polymesh-types declare the same members with different types | **122** | **Drop `@polkadot/api-augment`.** Not cosmetic — see below |
| TS2411 — `QueryableStorage`'s `[key: string]` index signature vs any augmented pallet | **54** | `skipLibCheck: true`, as polymesh-sdk does for the same reason |
| TS2694 — `@types/rimraf` × `glob` | 1 | Pre-existing, unrelated |

**The TS2717 class is the dangerous one.** `@polkadot/api-augment` describes the generic Substrate **kitchensink** runtime. Load it alongside the Polymesh augmentation and TypeScript keeps the *first* declaration, so **import order silently decides which chain your types describe** — 161 members, including `gasLimit` (kitchensink) where Polymesh has `weightLimit`, and `KitchensinkRuntimeOriginCaller` where Polymesh has `PolymeshRuntimeDevelopRuntimeOriginCaller`. Once `skipLibCheck` is on, nothing reports it. That is worse than no augmentation at all.

**Dropping it has a runtime cost that must be paid back.** `@polkadot/api-augment` also requires `@polkadot/types-augment`, which registers the base Substrate type definitions, and `@polkadot/api` does **not** load it on its own — verified by requiring `@polkadot/api` alone and counting: **0 modules** **[V]**. So the import must be *replaced*, not deleted:

```ts
import '@polkadot/types-augment';                                        // runtime registry
import '@polymeshassociation/polymesh-types/polkadot/types-lookup';      // must precede the next line
import '@polymeshassociation/polymesh-types/polkadot/augment-api';
```

**Five project call sites need to change**, not one — sites 4 and 5 only appear once `types-lookup` is imported, because until then the key type was itself broken and the call type-checked against nothing:

| Site | Fix |
|---|---|
| `mapMultiSigProposal.ts` — `multiSig.proposalDetail` | `legacyQuery('multiSig', 'proposalDetail', [0, 6_999_999])` |
| `genesisHandler.ts` — `multiSig.multiSigToIdentity` | `legacyQuery(...)` |
| `assets.ts` — `asset.customTypes(Codec)` | `getNumberValue(rawCustomId)` |
| `mapAsset.ts` — `asset.assetNames(Codec)` | `rawAssetId.toU8a()` |
| `mapAsset.ts` — `asset.fundingRound(Codec)` | `rawAssetId.toU8a()` |

**Project code type-checks clean with no suppression at all** — every error `skipLibCheck` hides is in `node_modules` **[V]**.

**A CJS/ESM hazard was investigated and is real but was not the cause.** `@polkadot/api-base` ships its declarations twice behind conditional exports — `types/storage.d.ts` and `cjs/types/storage.d.ts`, both on disk — and polymesh-types augments the bare specifier. `--traceResolution` confirms `moduleResolution: node` picks the first and `node16` the second **[V]**. Augmentation survives *both*, because within one program the augmentation and its consumers resolve identically. The hazard is a **mixed-mode** build, where one config augments one file while another reads the other and the chain types vanish silently. `moduleResolution` is now pinned explicitly in `tsconfig.json` so it cannot drift.

**The structural tension, which is the part worth carrying forward:**

> `polymesh-types` augments **one** metadata — the current one. An indexer reads **historical** storage across every spec version the chain has ever had.

So the two legacy errors are not a reason to roll the augmentation back; they are a reason to give it a named escape hatch — `legacyQuery(section, method, specRange)`, greppable, stating its spec range at the call site, and mechanically checkable against checked-in metadata. Same argument as the frozen legacy tuple table for events, applied to storage.

**Why this looked broken before [V]:** `src/types` is gitignored (it is `subql codegen` output), so a fresh checkout reports 11 "no exported member" errors until `yarn codegen` runs — after which the baseline is clean. There is no `typecheck` script. And `.eslintrc` sets no `parserOptions.project`, so linting carries **no type information at all**. Three gaps that together make the compiler invisible — and on a fresh checkout those 11 errors arrive mixed in with the 454 above, in `node_modules` files nobody wrote, with no script separating them. That is a very reasonable place to give up.

**Gates to add:** `yarn typecheck` (runs `codegen` first, then `tsc --noEmit -p tsconfig.test.json`) and `yarn check` (lint → typecheck → build → test:unit). Both were exercised on the prototype.

One limit worth stating so it is not over-sold: `QueryableStorage` has an index signature, so the augmentation does **not** catch a misspelled pallet or storage name — `api.query.nonexistentPallet.thing()` compiles either way **[V]**. What it buys is return types and argument types, which is where the real defects are.

Type-aware linting (`no-floating-promises` and friends) is noted **separately and later** — it will produce a large unrelated diff, and it should not be bundled with a change whose selling point is that it costs three errors. **[I]** that diff's size is unmeasured.

---

## 4. Sequencing changes

`architecture-review.md` §15 (renumbered from §9) gains a tier and reorders:

- **New Tier 0.5 — "make the compiler visible."** The `typecheck` gate, the augmentation, and the `Block` docstring. Cheapest work in the plan, no schema/runtime/consumer impact, and it makes every later tier safer to write.
- **A13 promoted into Tier 0** — a one-line correctness fix that needs no measurement to justify.
- **`timestamptz` and padded numeric ids pinned to Tier 3.** Both are trivial *during* the resync and awkward after it, so they must not slip past it.
- **The POLYX reconciliation harness is the acceptance gate for the ledger**, not a follow-up to it.
- **Partial indexing sequenced last (Tier 5)** — its seeding reuses Tier-3 seeders.

Two additions to "considered and rejected": upsert-everywhere as the answer to partial indexing, and — listed as **undecided rather than rejected** — a schema-wide epoch-integer timestamp.

---

## 5. Where each change landed

| Document | Change |
|---|---|
| [`README.md`](./README.md) | D8–D12; eight new resolved questions; open questions restructured into "needs a decision" / "answerable with a database" / "needs information"; counts and defect totals |
| [`architecture-review.md`](./architecture-review.md) | New §9 (total ordering), §10 (timestamps + the open epoch question), §11 (chain types), §12 (partial index), §13 (throughput), §14 (filtering/indexing discipline). Sequencing renumbered §9 → §15, with a new Tier 0.5 |
| [`entity-review.md`](./entity-review.md) | 67 → 69; `Block`/`Extrinsic`/`Event` verdicts corrected with an explicit correction note; `EvmTransaction`/`EvmAccountMapping` added; `IndexOrigin` listed missing; `StakingEvent` ⚠️ → ❌ with the accounting subsection; §15 relayer; third structural observation |
| [`reference/defect-log.md`](./reference/defect-log.md) | A13–A16, B9; §E open questions extended, two existing ones marked settled |
| [`reference/consumer-queries.md`](./reference/consumer-queries.md) | New §9 — filtering gaps observed in practice, and §9.6 recording the two items PRs #342/#343 closed |
| [`implementation/README.md`](./implementation/README.md) | Plans 10–12 in the table; new shared conventions for ordering, timestamps, array fields and chain reads |
| [`implementation/00-quick-fixes.md`](./implementation/00-quick-fixes.md) | A13 (fix now) and A14 (docstring now, id change with the rebuild) |
| [`implementation/02-polyx-ledger.md`](./implementation/02-polyx-ledger.md) | Accounting-fidelity section; reconciliation harness as an acceptance gate; genesis seeding written as a shared seeder |
| [`implementation/03-holdings-nfts.md`](./implementation/03-holdings-nfts.md) | `Nft` re-justified as the throughput fix, with the mechanism |
| [`implementation/09-infrastructure.md`](./implementation/09-infrastructure.md) | `timestamptz` conversion in `compat.sql`; §9.8 module-level state and the `Block` docstring; §9.9 pointing at the three new plans |
| **New:** [`10-partial-index.md`](./implementation/10-partial-index.md), [`11-throughput.md`](./implementation/11-throughput.md), [`12-types-and-ci.md`](./implementation/12-types-and-ci.md) | |

---

## 6. What did not change

Worth stating, so the revision is not read as broader than it is.

- **No code was changed.** This revision is documentation only. Plan [12](./implementation/12-types-and-ci.md) was implemented locally to cost it accurately and then reverted; the 454-error breakdown, the five call sites, the `Option<Bytes>` resolution and the `--traceResolution` results are all products of that prototype.
- **Every Tier 3 model decision stands.** The entry-centric ledger, portfolio-grain holdings, the POLYX pool redesign, `IdentityKey` — all unchanged. The new findings add verification requirements and a throughput justification; they do not alter a schema.
- **D1–D7 stand**, including D3 (historical state stays) and D5 (full resync). D3 in particular is now *load-bearing in a second way*: it is the reason array fields and mutation counts matter as much as row counts.
- **The claim-issuer collision (A12) is still the top priority.** Nothing found here displaces it.
- **No throughput measurement was performed.** §13 and plan 11 name four cost sources from code reading and say so; the numbers are still to be produced.
