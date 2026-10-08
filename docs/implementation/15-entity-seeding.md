# 15 — Entity seeding: every chain-held entity resolvable at any block

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an index started at any block, under any spec version, never stalls on and never silently zero-fills an entity the chain holds. Every handler lookup of such an entity goes through one path: the index, then chain storage as it stood when the block began, then a recorded anomaly.

**Architecture:** a registry of per-entity resolvers (`src/seed/resolvers/`) behind one lookup, `resolve(entity, id, ctx)`. Each resolver builds the row from `storageAtParent`, decoded with the block's own registry, so one resolver covers every runtime the storage item exists in. Bulk scans at the start block are kept only for values an index must hold *absolutely* from the first block: balances, holdings, holder counts. A static test fails any handler that reads a chain-held entity outside `resolve`.

**Tech Stack:** SubQuery (`@subql/types`, historical store), `@polkadot/api` inside the SubQuery sandbox, Jest unit tests, `scripts/check-state.ts` against an archive node.

**Spec:** [plan 10](./10-partial-index.md) §10.2–10.3 is the design this completes. Plan 10 built `IndexOrigin`, the start-block datasource, and seeders for balances, portfolio holdings, multisigs and EVM mappings; identities and v7+ assets resolve lazily. Everything else a handler reads is assumed to exist.

## Why one plan, not more point fixes

Two earlier commits (`44ee163` and `e0235e4`, kept under the tag `partial-start-fixes-2026-10-11`) fixed the three failures the first partial runs hit: assets missing while seeding holdings, ticker link and unlink with no indexed reservation, and testnet's undecodable `contracts` holds. Each fix was correct, but each added its own lookup-and-fallback shape, and the next partial run would hit the next entity. A handler survey (below) found **57 entity types** read by handlers, **about 110 lookup sites**, and four different miss behaviours:

| Miss behaviour | Effect on a partial index | Examples |
|---|---|---|
| **Throw** | The block retries forever | `Venue`, `Instruction` (affirm), `Sto` (closed), `Asset` (before v7), `Portfolio` (rename, delete), `Identity` (secondary-key events), `AgentGroupEntity`, `MultiSig`, `MultiSigProposal` (status) |
| **Create from zero** | A wrong total, silently | `Holding`, `AssetHolder`, `NftHolder`, `TickerReservation` |
| **Anomaly and skip** | The event is lost; recorded | `CorporateAction`, `CorporateBallot`, `Distribution`, `Proposal`, `Nft`, `Subsidy`, `CheckpointSchedule`, `MultiSigSigner`, `Claim` (revoke) |
| **Silent skip** | The event is lost; not recorded | `Authorization`, `ConfidentialAsset`, `Sto` (edits), `InstructionAffirmation`, `MultiSigAdmin` |

They were left out of the PR stack so the fix lands once, consistently. The tag keeps them as reference for Tasks 3 and 4.

## Global constraints

- **Read at the parent block.** A resolver reads chain state as it stood **before** the block being indexed (`storageAtParent`), never `api.query` (state after the block). After-block state already contains the effect of the event being handled: an asset resolved from it during `Issued` would carry the issued amount, and the handler would then add it again.
- **One registry, every runtime.** A resolver decodes with the block's registry. A storage item that runtime lacks reads as `undefined`, and the resolver returns `undefined`. No resolver branches on spec-version numbers except where the survey (Task 1) shows the same item changed shape.
- **No zero-filled rows for chain-held entities.** If the chain can't supply it, the handler gets `undefined` and an anomaly is recorded.
- **No thrown errors on a miss.** A handler meeting an unresolvable entity records `MissingReferencedEntity` and skips the change it can't apply. Throwing stalls the index forever on a gap nothing can fill.
- **Genesis replay unchanged.** On a full index a resolver hit is a gap in the index and is recorded as an anomaly, as today. On a partial index it is expected and is not.
- **History is not resolvable.** Events, past values, counts accumulated over time and pruned storage can't be read back. They are listed in `IndexOrigin.unseededDomains` with the reason, not guessed.
- **Gates for every task:** `yarn typecheck`, `npx jest --config jest.unit.config.js -i` (check the `Test Suites:` line; parallel workers hide suites that fail to serialise BigInt), `yarn lint`, `yarn check-handlers`, `yarn check-strict-null` (no rise above the baseline), `yarn build`.
- **Commits:** conventional with gitmoji (`feat: 🎸`, `fix: 🐛`, `test: 💍`, `docs: ✏️`). Mark breaking (`!`, `BREAKING CHANGE:`) only for a change against released `master`/`alpha`. Nothing in this plan should be.

## Review focus

1. **An entity created in the same block it is first referenced, by a call the index has no handler for.** The parent read finds nothing. Expected: a resolver for an entity with no accumulated fields retries at block end (`allowBlockEnd`); one with accumulated fields records the anomaly. Pinned in Task 2.
2. **The first block after a runtime upgrade.** Parent state was written by the old runtime, and the block's registry is the new one's. `storageAtParent` already returns `undefined` there. Expected: an anomaly naming the upgrade, not a decode crash. Pinned in Task 2.
3. **A child resolved before its parent.** For example a `Leg` before its `Instruction`, or a `Holding` before its `Asset`. Expected: the child's resolver resolves the parent through `resolve`, so the parent row exists before the child references it. Pinned in Tasks 6 and 7.
4. **Pruned storage.** The chain removes executed instructions, and multisig proposals and PIPs once finished (Task 1 lists exactly which). Expected: a terminal event for one is an anomaly whose detail says the storage was pruned, not a stall. Pinned in Tasks 7 and 9.
5. **Two handlers in one block resolving the same entity.** Expected: one row; the second lookup reads the index. Pinned in Task 2.

---

## The survey: what handlers read today

Measured on `redesign/13-consumer-requests` (2026-10-11) by grepping `Entity.get(` in `src/mappings` and `src/utils`, with the three lines after each call. Grouped into the tasks below; the right column is the v8 storage that resolves each one.

| Task | Entity | Sites | v8 storage (key) |
|---|---|---|---|
| 3 | `Identity`, `Account`, `Portfolio` | 7, 9, 4 | `identity.didRecords(did)`, `identity.keyRecords(account)`, `portfolio.portfolios(did, n)` |
| 3 | `Asset`, `TickerReservation` | 6, 2 | `asset.assets(id)` and its siblings; `asset.uniqueTickerRegistration(ticker)`, `asset.tickerAssetId(ticker)` |
| 4 | `Claim`, `CustomClaimType`, `Authorization` | 1, 1, 2 | `identity.claims(1stKey, 2ndKey)`, `identity.customClaims(id)`, `identity.authorizations(signatory, authId)` |
| 5 | `AgentGroupEntity` | 2 | `externalAgents.groupPermissions(assetId, agId)` |
| 5 | `AssetMetadata`, `GlobalMetadataKey`, `CustomAssetType` | 2, 3, 2 | `asset.assetMetadataValues`, `…ValueDetails`, `…GlobalKeyToName`, `…GlobalSpecs`; `asset.customTypes(id)` |
| 5 | `StatType`, `TransferCompliance`, `TransferComplianceExemption` | 1, 1, 1 | `statistics.activeAssetStats(assetId)`, `statistics.assetTransferCompliances(assetId)`, `statistics.transferConditionExemptEntities` |
| 5 | `CheckpointSchedule` | 1 | `checkpoint.scheduledCheckpoints(assetId, scheduleId)` |
| 6 | `Holding`, `AssetHolder`, `AssetAllowance` | 1, 1, 1 | `portfolio.portfolioAssetBalances`, `asset.assetBalance(account, assetId)`, `asset.allowances(owner, spender, assetId)` |
| 6 | `Nft`, `NftHolder`, `NftApproval`, `NftOperatorApproval` | 3, 1, 1, 1 | `portfolio.portfolioNFT`, `nft.nftHolder(account, assetId, nftId)`, `nft.tokenApproval(assetId, nftId)`, `nft.operatorApproval` |
| 7 | `Venue`, `Instruction`, `Leg`, `InstructionAffirmation`, `InstructionParty` | 1, 2, 1, 3, 1 | `settlement.venueInfo(id)`, `settlement.instructionDetails(id)`, `settlement.instructionLegs(id, legId)`, `settlement.userAffirmations(holder, id)` |
| 8 | `CorporateAction`, `CorporateActionDefaultConfig`, `Distribution` | 5, 1, 1 | `corporateAction.corporateActions(assetId, localId)`, `corporateAction.defaultTargetIdentities`/`defaultWithholdingTax`, `capitalDistribution.distributions(caId)` |
| 8 | `CorporateBallot`, `CorporateBallotVote` | 4, 1 | `corporateBallot.metas`, `timeRanges`, `motionNumChoices`, `rcv` by `caId`; `corporateBallot.votes(caId, did)` |
| 8 | `Sto` | 3 | `sto.fundraisers(assetId, id)`, `sto.fundraiserNames(assetId, id)` |
| 9 | `Proposal`, `ProposalVote` | 2, 1 | `pips.proposals(id)`, `pips.proposalMetadata(id)`, `pips.proposalStates(id)`, `pips.proposalVotes(id, account)` |
| 9 | `MultiSig`, `MultiSigSigner`, `MultiSigAdmin`, `MultiSigProposal`, `MultiSigProposalVote` | 1, 2, 1, 3, 1 | `multiSig.multiSigSigners`, `multiSigSignsRequired`, `adminDid`, `proposals(multisig, id)`, `proposalStates`, `votes((multisig, id), signer)` |
| 9 | `Subsidy` | 3 | `relayer.subsidies(user)` |
| 10 | `StakingPosition`, `Validator`, `Era` | 5, 1, 2 | `staking.ledger`, `staking.bonded`, `staking.payee`, `staking.validators`, `staking.activeEra` |
| 10 | `ConfidentialAsset`, `ConfidentialSettlement`, `ConfidentialLegAffirmation`, `ConfidentialCurveTreeLeaf` | 2, 1, 1, 1 | the confidential pallet's storage on chains that run it (Task 1 confirms which) |
| — | `AccountBalance`, `EvmAccountMapping` | 8, 1 | already seeded at the start block |

**Not resolvable, by nature:** `IdentityKey` history, `AssetAgentHistory`, every `*Event`/`*Transaction`/`PolyxEntry` ledger row, `Asset.totalTransfers`, lifetime totals on `AccountBalance`, and votes on finished proposals the chain has pruned. They start at the start block, which `IndexOrigin` states.

---

## File structure

| File | Responsibility |
|---|---|
| `scripts/survey-storage-history.ts` | Records every storage item's key and value types per runtime, like `survey-event-history.ts` does for events |
| `tests/fixtures/storage-history.json` | Its output, checked in |
| `src/seed/resolve.ts` | `resolve()`, the registry, `ResolveContext`, anomaly recording, block-end fallback |
| `src/seed/resolvers/<domain>.ts` | One file per task's domain: `identity.ts`, `asset.ts`, `claims.ts`, `assetConfig.ts`, `holdings.ts`, `settlement.ts`, `corporateActions.ts`, `governance.ts`, `staking.ts`, `confidential.ts` |
| `src/seed/resolvers/index.ts` | Registers every resolver; imported once by `src/mappings/mappingHandlers.ts` |
| `src/seed/holding.ts`, `src/seed/accountBalance.ts` | The existing start-block scans, extended in Task 6 |
| `src/mappings/indexOrigin.ts` | `DOMAINS` / `UNSEEDED_FROM_START_BLOCK`, moved as each task lands |
| `tests/unit/resolveGuard.test.ts` | The static check that every chain-held entity is read through `resolve` |
| `tests/unit/resolvers/<domain>.test.ts` | One per resolver file |

The lookup helpers that exist today become thin wrappers or go: `getAsset`, `getAssetOrAnomaly`, `getOrAnomaly`, `resolveIdentity`, `assetFromChain`, `getOrCreateAccount`'s chain path, `createPortfolioIfNotExists`. Task 3 folds them into resolvers, and removes each once its callers are moved.

---

### Task 1: Storage history survey

Pins, for every storage item a resolver will read, its key and value types in every runtime both chains have run. This replaces guessing which items existed when and how they were keyed (ticker before v7, `AssetId` after, multisig's v7 rework, and so on).

**Files:**
- Create: `scripts/survey-storage-history.ts`
- Create: `tests/fixtures/storage-history.json`
- Create: `tests/unit/storageHistory.test.ts`

**Interfaces:**
- Produces: `storage-history.json` with this shape, which later tasks' tests read:

```ts
interface StorageHistory {
  /** `section.item`, camelCased as `api.query` names them */
  [item: string]: {
    /** inclusive spec-version ranges over which the item kept one shape */
    ranges: { from: number; to: number | null; keys: string[]; value: string; hashers: string[] }[];
  };
}
```

- [ ] **Step 1: Write the script.** Reuse `survey-event-history.ts`'s runtime discovery: it already bisects each chain for spec changes and caches each runtime's metadata in `tmpdir()/polymesh-event-history`. For each runtime, walk `metadata.asLatest.pallets[].storage.items`, and record `section.item` with the key types (`createLookupType` of each key), value type and hashers. Restrict the output to the sections in the survey table above, plus `system`, `balances` and `revive`. Merge identical consecutive shapes into ranges.
- [ ] **Step 2: Run it** against both archive nodes (the dev server's; see `docs/dev-server-testnet-sync.md`):

```bash
yarn ts-node scripts/survey-storage-history.ts mainnet=<archive rpc> testnet=<archive rpc>
```

- [ ] **Step 3: Record pruning.** For every item in a terminal path (instruction details and legs, multisig proposals, PIPs, authorizations, corporate-action ballots), read the pallet source at each tag in `../Polymesh` that the ranges span, and note in a `pruned` field when the chain removes the entry: for example `settlement.instructionLegs: removed on execution from v6.0`. This field is what Tasks 7 and 9 use to word their anomalies.
- [ ] **Step 4: Write the guard test.** It asserts every `section.item` a resolver reads (each resolver exports a `READS: string[]`) appears in the fixture, so a resolver can't read an item no runtime has.

```ts
import history from '../fixtures/storage-history.json';
import { allResolverReads } from '../../src/seed/resolvers';

it('only reads storage some runtime has', () => {
  const unknown = allResolverReads().filter(item => !(item in history));
  expect(unknown).toEqual([]);
});
```

  (`allResolverReads` lands in Task 2; until then, the test reads a literal list.)
- [ ] **Step 5: Commit** `feat: 🎸 survey every storage item's shape across runtimes`.

---

### Task 2: `resolve()` and the guard

**Files:**
- Create: `src/seed/resolve.ts`
- Create: `src/seed/resolvers/index.ts`
- Create: `tests/unit/resolve.test.ts`
- Create: `tests/unit/resolveGuard.test.ts`

**Interfaces:**
- Consumes: `storageAtParent`, `storageEntriesAtParent`, `UndecodableStateError` (`src/utils/storageAtParent.ts`); `recordAnomaly` (`src/utils/anomaly.ts`); `isPartialIndex` (`src/mappings/indexOrigin.ts`).
- Produces:

```ts
export interface ResolveContext {
  block: SubstrateBlock;
  blockId: string;
  /** the event the lookup is for, or `SEED_EVENT_ID` for a start-block scan */
  blockEventId: string;
  eventIdx: number;
  moduleId?: ModuleIdEnum;
  eventId?: EventIdEnum;
}

export interface Resolver<T> {
  entity: string;
  /** storage items read, as `section.item`, for the Task 1 guard */
  reads: string[];
  /** the row as the chain held it when the block began, saved; `undefined` if the chain has none */
  fromChain(id: string, ctx: ResolveContext): Promise<T | undefined>;
  /**
   * The row carries no value the index accumulates from events, so the state at the end of the
   * block is also a correct source (Review focus 1).
   */
  allowBlockEnd?: boolean;
}

export const registerResolver: <T>(resolver: Resolver<T>) => void;
export const resolve: <T>(entity: string, id: string, ctx: ResolveContext) => Promise<T | undefined>;
export const contextOf: (event: SubstrateEvent) => ResolveContext; // from extractArgs
export const allResolverReads: () => string[];
```

`resolve` does, in order:
1. `store.get(entity, id)`: if found, return it.
2. The registered resolver's `fromChain(id, ctx)`. On `UndecodableStateError`, record an `UndecodableState` anomaly and return `undefined`.
3. If `undefined` and `allowBlockEnd`, `fromChain` again with block-end reads. Implement this by passing `ctx` with `atBlockEnd: true`, which each resolver's storage helper honours. Use `api.query` for that read.
4. If found: on a genesis replay record `MissingReferencedEntity` ("resolved from chain: the index never wrote it"). On a partial index, record nothing.
5. If not found: record `MissingReferencedEntity` naming the entity, the id, and why. The reasons are: not on chain at the parent, storage item absent in this runtime, or the parent written by an older runtime.

An in-flight `Map<string, Promise<T | undefined>>` keyed by `entity/id`, cleared when the block changes, covers Review focus 5. It works the same way as the payee prefetch in `utils/staking.ts`.

- [ ] **Step 1: Write the failing tests** in `tests/unit/resolve.test.ts`, mocking `store.get`, `storageAtParent` and `recordAnomaly`:
  - returns the indexed row without calling the resolver;
  - calls the resolver on a miss, and returns its row;
  - records `MissingReferencedEntity` when the resolver returns `undefined`, and returns `undefined`;
  - records nothing on a partial index when the resolver finds the row, and records the gap on a genesis replay;
  - retries at block end only for `allowBlockEnd` resolvers;
  - turns `UndecodableStateError` into an anomaly, not a throw;
  - two concurrent `resolve('Venue', '1', ctx)` calls run `fromChain` once;
  - throws if no resolver is registered for the entity, since that's a programming error caught in tests.
- [ ] **Step 2: Run** `npx jest --config jest.unit.config.js -i tests/unit/resolve.test.ts`. Expect failures: module not found.
- [ ] **Step 3: Implement** `src/seed/resolve.ts` to the interface above.
- [ ] **Step 4: Run the test again.** Expect it to pass.
- [ ] **Step 5: Write the guard.** `tests/unit/resolveGuard.test.ts` reads every `.ts` under `src/mappings` and `src/utils`, finds `\b(<Entity>)\.get\(` for each entity in the survey table, and fails unless the file is a resolver or the line carries `// resolve-guard: <reason>`. It's the same shape as `storeQueryIndexes.test.ts`. Seed its allowlist with today's sites, so the test passes now and each later task deletes its lines from the allowlist:

```ts
const CHAIN_HELD = ['Identity', 'Account', 'Portfolio', 'Asset', /* … every entity in the survey */];
const ALLOWED_TODAY: Record<string, number> = {
  // file: count of direct reads still to move; each task removes its entries
  'src/mappings/entities/settlements/mapVenue.ts': 1,
};
```

- [ ] **Step 6: Commit** `feat: 🎸 resolve a missing entity from chain state in one place`.

---

### Task 3: Identities, accounts, portfolios, assets and tickers onto `resolve`

The resolvers that exist today, moved behind `resolve` and switched to parent-state reads.

**Files:**
- Create: `src/seed/resolvers/identity.ts` (`Identity`, `Account`, `Portfolio`)
- Create: `src/seed/resolvers/asset.ts` (`Asset`, `TickerReservation`)
- Modify: `src/mappings/entities/assets/assetFromChain.ts` (becomes the `Asset` resolver's body; the file is deleted at the end)
- Modify: `src/mappings/entities/identities/mapIdentities.ts` (`resolveIdentity` → `resolve('Identity', …)`)
- Modify: `src/utils/accounts.ts` (`getOrCreateAccount`'s chain path)
- Modify: `src/mappings/entities/common.ts` (`getAsset`, `getAssetOrAnomaly`, `getOrAnomaly` delegate to `resolve`)
- Modify: `src/mappings/entities/assets/mapTickers.ts`, `mapPortfolio.ts`, `src/seed/holding.ts`
- Test: `tests/unit/resolvers/identity.test.ts`, `tests/unit/resolvers/asset.test.ts`, plus the existing `mapTickers`, `mapIdentities`, `mapPortfolio`, `seedHoldings` and `getAssetOrAnomaly` tests

**Interfaces:**
- Consumes: Task 2's `resolve`, `registerResolver`, `contextOf`.
- Produces: resolvers for `Identity` (id = DID), `Account` (id = address), `Portfolio` (id = `did/number`), `Asset` (id = asset id, or ticker before v7, the same id the handlers use), `TickerReservation` (id = ticker).

**What each one reads:**
- **`Identity`:** `identity.didRecords(did)`: primary key. Creates the default portfolio `did/0` too, as `resolveIdentity` does today.
- **`Account`:** `identity.keyRecords(address)`, giving the identity, primary or secondary, and the multisig's creator. Reuse `getAccountKeyType` / `keyRoleFor`.
- **`Portfolio`:**
  - `portfolio.portfolios(did, number)` for the name, `portfolio.portfolioCustodian(did-number)` for the custodian;
  - number 0 always exists for a known identity;
  - it resolves the owning `Identity` first.
- **`Asset`:**
  - v7+: what `assetFromChainAt` (in `44ee163`) reads, but at the parent.
  - Before v7: the ticker-keyed items the Task 1 fixture names (`asset.tokens(ticker)` up to v6) — the same fields under older names.
  - `holderCount` and `totalTransfers` start at 0, which `IndexOrigin` already states.
- **`TickerReservation`:**
  - `asset.uniqueTickerRegistration(ticker)` (owner, expiry), and `asset.tickerAssetId(ticker)` for the linked asset (v7+).
  - Before v7, `asset.tickers(ticker)`.
  - This replaces `44ee163`'s `reservationOf`.

- [ ] **Step 1: Failing resolver tests.** For each resolver: the row built from mocked parent storage; `undefined` when the storage is `None`; `undefined` when the item is missing from the runtime (pre-v7 `tickerAssetId`). Assert the `Asset` resolver reads at the parent: give `storageAtParent` and `api.query` different supplies, and expect the parent's.
- [ ] **Step 2: Run them.** Expect failure.
- [ ] **Step 3: Implement the resolvers.** Then move every caller:
  - **Asset reads:** `getAsset` throws on `undefined` today; make it return `Asset | undefined` and fix each caller to record-and-skip. Typecheck lists them.
  - **Ticker handlers:** `mapTickers.ts` link/unlink use `resolve('TickerReservation', …)`.
  - **Portfolio rename:** it no longer throws.
  - **Holdings seed:** `seedHoldings` resolves each asset through `resolve` with `blockEventId: SEED_EVENT_ID`.
- [ ] **Step 4: Run the tests again.** Expect all of the following to pass:
  - the resolver tests;
  - `mapTickers`, `mapPortfolio`, `seedHoldings` and `mapIdentities`;
  - the whole suite.
- [ ] **Step 5:** Remove these files' entries from `resolveGuard`'s allowlist, and delete `assetFromChain.ts` and `getAssetOrAnomaly` once nothing imports them.
- [ ] **Step 6:** In `indexOrigin.ts`, change the `identities` and `assets` reasons to "resolved from chain storage at the parent block, the first time one is referenced (every runtime)".
- [ ] **Step 7: Commit** `feat: 🎸 resolve identities, accounts, portfolios, assets and tickers through one path`.

---

### Task 4: Raw holds, claims, custom claim types, authorizations

**Files:**
- Modify: `src/mappings/entities/identities/ledgerCore.ts` and `src/seed/accountBalance.ts`: port `e0235e4` (tag `partial-start-fixes-2026-10-11`), which reads holds today's metadata can't decode from raw storage. It predates JSON amounts becoming strings, so its `HoldEntry` amounts become `Hold` (bigint) through `holdsOf`/`setHolds`.
- Create: `src/seed/resolvers/claims.ts` (`Claim`, `CustomClaimType`, `Authorization`)
- Modify: `mapClaim.ts`, `mapIdentities.ts` (custom claim types), `mapAuthorization.ts`, `feePayer.ts`
- Test: `tests/unit/readChainHolds.test.ts` (comes with the cherry-pick), `tests/unit/resolvers/claims.test.ts`

**Interfaces:**
- Consumes: `resolve` and `contextOf`; the `Identity` resolver (a claim's target and issuer).
- Produces:
  - **`Claim`:** the index's claim id. Task 1's fixture gives the key layouts: v8 is `(Claim1stKey{target, claimType}, Claim2ndKey{issuer, scope})`. The resolver parses the id into those parts.
  - **`CustomClaimType`:** id = numeric id.
  - **`Authorization`:** `padNumericId(authId)`. The signatory isn't in the id, so the resolver takes it from `ctx`. Each handler that reads one has the target in its event arguments; pass it as `resolve('Authorization', id, { ...ctx, hint: { signatory } })`. Add `hint?: Record<string, unknown>` to `ResolveContext` in this task.

- [ ] **Step 1: Port and gate.**

```bash
git fetch origin tag partial-start-fixes-2026-10-11
git cherry-pick e0235e4   # resolve ledgerCore.ts: keep `Hold[]`, convert with holdsOf/setHolds
```

  Then confirm `readChainHolds` still passes, and run the gates.
- [ ] **Step 2: Failing tests** for the three resolvers:
  - built from storage;
  - `undefined` when absent;
  - an `Authorization` consumed before the start block resolves `undefined`, and its terminal event records the anomaly instead of silently returning, as `mapAuthorization.ts:29` does today.
- [ ] **Step 3: Implement**, move the callers, and shrink the allowlist.
- [ ] **Step 4: Run the tests.** Expect a pass.
- [ ] **Step 5: Commit** in two parts:
  - `fix: 🐛 read holds today's metadata can't decode from raw storage` (the port);
  - `feat: 🎸 resolve claims, custom claim types and authorizations from chain`.

---

### Task 5: Asset configuration: agents, metadata, custom types, statistics, compliance, checkpoints

**Files:**
- Create: `src/seed/resolvers/assetConfig.ts`
- Modify:
  - `mapExternalAgentHistory.ts` (the two `AgentGroupEntity.get` that throw today);
  - `mapAssetMetadata.ts`;
  - `src/utils/assets.ts` (`CustomAssetType`);
  - `mapStatistics.ts`;
  - `mapCheckpoint.ts`.
- Test: `tests/unit/resolvers/assetConfig.test.ts`, plus the existing handler tests for each file

**Interfaces:** resolvers for these entities:
- **`AgentGroupEntity`:** `assetId/agId`, from `externalAgents.groupPermissions`.
- **`AssetMetadata`:** `assetId/key`, from `asset.assetMetadataValues` and `assetMetadataValueDetails`; the name from the local or global key-to-name map.
- **`GlobalMetadataKey`:** id, from `assetMetadataGlobalKeyToName` and `assetMetadataGlobalSpecs`.
- **`CustomAssetType`:** id, from `asset.customTypes`.
- **`StatType`:** `assetId/type`, from `statistics.activeAssetStats`.
- **`TransferCompliance`:** from `statistics.assetTransferCompliances`.
- **`TransferComplianceExemption`:** from `statistics.transferConditionExemptEntities`.
- **`CheckpointSchedule`:** `assetId/scheduleId`, from the checkpoint storage the Task 1 fixture names for the runtime (v7 moved it).

All of these but `StatType` have no accumulated fields: set `allowBlockEnd: true`.

- [ ] **Step 1:** Failing tests: each resolver built from storage, and `undefined` when absent. Add a handler test: `handleGroupPermissionsUpdated` with no indexed group resolves it, and doesn't throw.
- [ ] **Step 2: Run them.** Expect failure.
- [ ] **Step 3: Implement.**
  - `getOrCreate` sites that build from event data alone (`StatType`, `TransferCompliance`) only change when the event carries part of the row. A full-state event (`TransferConditionsSet` carries the whole set) stays as it is, since the event is the truth.
  - Resolve only where a handler reads a field the event doesn't carry.
- [ ] **Step 4: Run** the tests. Expect a pass.
- [ ] **Step 5: Commit** `feat: 🎸 resolve asset agents, metadata, statistics and checkpoints from chain`.

---

### Task 6: Holdings, NFTs and allowances, and their counts

Plan 10 seeds portfolio holdings. This task adds what it left out:
- v8 account-level holdings;
- NFTs;
- allowances;
- the holder counts.

These are aggregates, so it **scans** at the start block rather than resolving lazily. A lazily resolved holding would be right for its own balance and wrong for `Asset.holderCount`.

**Files:**
- Modify: `src/seed/holding.ts`
  - account-level balances: `asset.assetBalance` entries (v8);
  - NFT ownership: `portfolio.portfolioNFT` and `nft.nftHolder` entries;
  - set `Asset.holderCount` from the scan.
- Create: `src/seed/resolvers/holdings.ts`
  - `Nft`, `NftApproval`, `NftOperatorApproval`, `AssetAllowance`;
  - `Holding`, `AssetHolder` and `NftHolder` too, for a genesis-replay gap only. On a partial index those are fully seeded, so a miss means a real zero.
- Modify: `mapAsset.ts:156,185,1007`, `mapNfts.ts`, `mapNftApprovals.ts`, `src/mappings/indexOrigin.ts` (`accountHoldings`, `nfts`, `assetCounts` move to seeded)
- Test: `tests/unit/seedHoldings.test.ts`, `tests/unit/resolvers/holdings.test.ts`

**Interfaces:**
- Consumes: the `Asset` and `Portfolio` resolvers (Task 3), and `storageEntriesAtParent`.
- Produces: `seedHoldings` returns `{ seeded, accounts, nfts }`; `IndexOrigin` lists the three domains as seeded.

- [ ] **Step 1: Failing seed tests** with mocked entries:
  - v8 account balances become `Holding` rows and `AssetHolder` rows;
  - `holderCount` equals the distinct holders scanned;
  - an NFT in a portfolio creates its `Nft` and `NftHolder`;
  - an asset in a holding that the index lacks is resolved first (Review focus 3).
- [ ] **Step 2: Run them.** Expect failure.
- [ ] **Step 3: Implement.** Use `storageEntriesAtParent`, paged; it already pages at 1,000 keys.
- [ ] **Step 4: Run** the tests. Expect a pass.
- [ ] **Step 5: Server check.** On a partial run, `check-state.ts` checks 1–3 (balances, holdings, NFTs) report 0 differences at the start block + 1,000.
- [ ] **Step 6: Commit** `feat: 🎸 seed account holdings, NFTs and holder counts at the start block`.

---

### Task 7: Settlement

**Files:**
- Create: `src/seed/resolvers/settlement.ts`
- Modify: `mapVenue.ts:33` (throws today), `mapSettlement.ts:183,219,292,465,513,545,881`
- Test: `tests/unit/resolvers/settlement.test.ts`, `tests/unit/mapSettlement.test.ts`, `tests/unit/mapVenue.test.ts`

**Interfaces:** resolvers for these entities:
- **`Venue`:** id, from `settlement.venueInfo` and `settlement.details`; signers from `venueSigners`.
- **`Instruction`:** id, from `settlement.instructionDetails`, `instructionStatuses` and `instructionMemos`. Resolving it also resolves its `Leg`s, from `instructionLegs`, and its venue.
- **`Leg`:** `instructionId/legId`; it resolves its `Instruction`.
- **`InstructionAffirmation`:** `instructionId/did`, from `settlement.userAffirmations` and `affirmsReceived`.
- **`InstructionParty`:** from the legs' portfolios.

- [ ] **Step 1: Failing tests:**
  - an affirmation event for an instruction created before the start block resolves the instruction, its legs and its venue, then applies;
  - an execution event for an instruction whose storage was pruned (per the Task 1 `pruned` field) records an anomaly that says so, and doesn't throw (`mapSettlement.ts:219`).
- [ ] **Step 2: Run them.** Expect failure.
- [ ] **Step 3: Implement**, move the callers, and shrink the allowlist.
- [ ] **Step 4: Run.** Expect a pass.
- [ ] **Step 5: Commit** `feat: 🎸 resolve venues and in-flight instructions from chain`.

---

### Task 8: Corporate actions, ballots, distributions, offerings

**Files:**
- Create: `src/seed/resolvers/corporateActions.ts`
- Modify: `mapCorporateAction.ts`, `mapCorporateActions.ts`, `mapCorporateBallot.ts`, `mapSto.ts:83,106,139` (`:106` throws today)
- Test: `tests/unit/resolvers/corporateActions.test.ts` and the existing handler tests

**Interfaces:** resolvers for these entities:
- **`CorporateAction`:** `assetId/localId`, from `corporateAction.corporateActions` and `details`; documents from `caDocLink`.
- **`CorporateActionDefaultConfig`:** assetId, from `defaultTargetIdentities`, `defaultWithholdingTax` and `didWithholdingTax` entries.
- **`Distribution`:** from `capitalDistribution.distributions(caId)`.
- **`CorporateBallot`:** from `corporateBallot.metas`, `timeRanges`, `motionNumChoices` and `rcv`.
- **`CorporateBallotVote`:** from `corporateBallot.votes(caId, did)`.
- **`Sto`:** `assetId/id`, from `sto.fundraisers` and `fundraiserNames`.

Each resolves its `CorporateAction` or `Asset` first.

- [ ] **Step 1: Failing tests.** For each: built from storage, and `undefined` when absent. For handlers:
  - a ballot vote on a ballot created before the start block resolves the ballot and applies the vote;
  - `handleFundraiserClosed` on an unindexed offering resolves it and doesn't throw.
- [ ] **Step 2: Run.** Expect failure.
- [ ] **Step 3: Implement.** Mind `CorporateBallot.totals`, which is accumulated from votes. The resolver rebuilds it from `corporateBallot.results(caId)`, so it isn't zero-filled.
- [ ] **Step 4: Run.** Expect a pass.
- [ ] **Step 5: Commit** `feat: 🎸 resolve corporate actions, ballots, distributions and offerings from chain`.

---

### Task 9: PIPs, multisigs and subsidies

**Files:**
- Create: `src/seed/resolvers/governance.ts`
- Modify:
  - `mapProposal.ts`, `preV8Ledger.ts:720`;
  - `mapMultiSig.ts:203,223,317,390,413` (`:413` dereferences `undefined` today);
  - `mapMultiSigProposal.ts:119,201` (`:119` dereferences `undefined` today);
  - `metadataKeyResolver.ts:181`, `mapSubsidy.ts`;
  - `src/mappings/migrations/genesisHandler.ts`: the multisig seed becomes resolver calls, so genesis and partial starts share one path.
- Test: `tests/unit/resolvers/governance.test.ts` and the existing handler tests

**Interfaces:** resolvers for these entities:
- **`Proposal`:** padded pip id, from `pips.proposals`, `proposalMetadata`, `proposalStates` and `deposits`. Vote totals come from `proposalResult`.
- **`ProposalVote`:** from `pips.proposalVotes`.
- **`MultiSig`:** address, from `multiSig.multiSigSignsRequired`, `adminDid` and `payingDid`; signers from `multiSigSigners` entries for that multisig.
- **`MultiSigSigner`** and **`MultiSigAdmin`:** from the same storage.
- **`MultiSigProposal`:** `multisig/id`, from `multiSig.proposals`, `proposalStates` and `proposalVoteCounts`. The pre-v7 layout comes from the Task 1 fixture.
- **`MultiSigProposalVote`:** from `multiSig.votes`.
- **`Subsidy`:** user key, from `relayer.subsidies`.

- [ ] **Step 1: Failing tests:**
  - a vote on a multisig proposal created before the start block resolves the proposal and counts the vote;
  - `handleMultiSigSignaturesRequiredChanged` on an unindexed multisig resolves it;
  - a PIP whose storage was pruned records the anomaly and doesn't throw.
- [ ] **Step 2: Run.** Expect failure.
- [ ] **Step 3: Implement.** Move the genesis multisig seed onto the resolvers, and shrink the allowlist.
- [ ] **Step 4: Run.** Expect a pass.
- [ ] **Step 5: Commit** `feat: 🎸 resolve PIPs, multisigs and subsidies from chain`.

---

### Task 10: Staking and confidential assets

**Files:**
- Create: `src/seed/resolvers/staking.ts`, `src/seed/resolvers/confidential.ts`
- Modify: `mapStakingPosition.ts:34,166`, `mapStakingEvent.ts:282`, `mapPolyxLedger.ts:1147`, `mapValidator.ts`, `mapEra.ts`, and the confidential handlers
- Test: `tests/unit/resolvers/staking.test.ts`, `tests/unit/resolvers/confidential.test.ts`

**Interfaces:** resolvers for these entities:
- **`StakingPosition`:** stash, from `staking.ledger(controller)`, which `staking.bonded(stash)` locates before v8; v8 keys the ledger by stash. Also `staking.payee(stash)`. `bonded`, `unbonding` and `controllerId` are what `check-state.ts` check 6 compares.
- **`Validator`:** stash, from `staking.validators`.
- **`Era`:** index, from `staking.activeEra` and `erasStartSessionIndex`. Points and payouts are history, and stay as they are.
- **Confidential entities:** from the confidential pallet's storage, only where Task 1 finds the pallet. Elsewhere there are no resolvers, and the guard allowlists them with that reason.

- [ ] **Step 1: Failing tests:**
  - a restake (`Rewarded`, `Staked` destination) for a stash bonded before the start block resolves the position at the parent, then adds the reward once;
  - `handleUnbonded` on an unindexed position resolves it, and doesn't silently return (`mapStakingPosition.ts:166`).
- [ ] **Step 2: Run.** Expect failure.
- [ ] **Step 3: Implement**, and shrink the allowlist. It should now be empty except for the commented allowances.
- [ ] **Step 4: Run.** Expect a pass.
- [ ] **Step 5: Commit** `feat: 🎸 resolve staking positions, validators and eras from chain`.

---

### Task 11: Prove it on both chains

**Files:**
- Modify: `src/mappings/indexOrigin.ts`: every domain's reason now says seeded or resolved. What remains in `UNSEEDED_FROM_START_BLOCK` is history only.
- Modify: `docs/implementation/10-partial-index.md`, `docs/reference/consumer-queries.md` (what a partial index guarantees)
- Modify: `scripts/check-state.ts`: if any entity in Tasks 4–10 has no check yet, add one for those whose chain state is cheap to compare (venues, in-flight instructions, multisig signers, agent groups).

- [ ] **Step 1:** Run the empty-store harness. Every handler test fixture runs with the store mocked empty and every resolver returning `undefined`. Each must complete without throwing, and record an anomaly or skip. Add this as `tests/unit/emptyStore.test.ts`, iterating the handler map that `check-handlers.ts` already builds.
- [ ] **Step 2: Dev server, partial runs.** Three start blocks per chain, each in a different runtime era:
  - **Testnet:** one before v6, one in v6–v7, and 25,500,000.
  - **Mainnet:** one before v7, one in v7, and the v8 head minus 100,000.
  - **Each run** goes 50,000 blocks.
  - **Expect:** no failed blocks; `MissingReferencedEntity` only with pruned-storage reasons; `check-state.ts` 0 differences at the start + 1,000 and at the end.
- [ ] **Step 3: Dev server, genesis resync** on the same build: no change from the last clean run (0 drift, 0 anomalies on mainnet). A resolver firing on a genesis replay is a gap and shows up as an anomaly.
- [ ] **Step 4: Commit** `docs: ✏️ describe what a partial index guarantees`.

---

## Open decisions (for review)

1. **Is anomaly-and-skip right for unresolvable entities?** The alternative is failing the block, which on a partial index means it never progresses. Recommended: skip and record; `IndexOrigin` explains it.
2. **Should pre-v6 start blocks be supported?** The resolvers cost the same in every runtime; the fixture and the tests are where older runtimes cost more. Recommended: yes, since the survey makes it mechanical. Narrow it if Task 1 shows many reshaped items before v6.
3. **Should `getAsset` stop throwing?** Recommended: yes. On a genesis replay a missing asset is still an anomaly, and the server checks show none today.
