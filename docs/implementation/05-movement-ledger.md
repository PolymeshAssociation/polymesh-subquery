# 05 — Movement ledger

Folds `PortfolioMovement` into `AssetTransaction` so every asset movement is one row in one table. Originally proposed in Francis's *One Movement Ledger* draft; independently verified here.

**Entities:** `AssetTransaction` (extended), `PortfolioMovement` (removed).

**Depends on:** [03](./03-holdings-nfts.md) — shares the holder-classification helper.

---

## Why it is safe

The two tables provably do **not** overlap, so folding them cannot double count **[V]**:

| Chain event | Identity constraint | Reaches `AssetTransaction` today? |
|---|---|---|
| `portfolio.FundsMovedBetweenPortfolios` | same DID, enforced | No |
| `portfolio.MovedBetweenPortfolios` | same DID, pre-6.0 equivalent | No |
| `settlement.FundsTransferred` | same DID — the `same_did` fast path | No |
| `asset.AssetBalanceUpdated` | none | Yes |

Every writer of `PortfolioMovement` is intra-Identity, and intra-Identity movement emits **no** `AssetBalanceUpdated` — `Asset::transfer_holders_balance` deposits no event, correctly, since no Identity's holding changed.

So `AssetTransaction` is currently an **incomplete** movement ledger, and adding the missing rows fills a gap rather than duplicating.

`Leg` stays separate: it records *intent* (a leg can exist for an instruction that never executes, and off-chain legs have no portfolio), not *effect*.

---

## Target schema

```diff
  type AssetTransaction @entity {
    id: ID!
    asset: Asset!
    fromPortfolio: Portfolio
    fromAccount: String
    fromIdentity: Identity @index(unique: false)
    toPortfolio: Portfolio
    toAccount: String
    toIdentity: Identity @index(unique: false)
    amount: BigInt
    nftIds: [BigInt]
    eventId: EventIdEnum!
    eventIdx: Int!
    extrinsicIdx: Int
    fundingRound: String
    instruction: Instruction
    instructionMemo: String
+   "true when both sides belong to one Identity; null for issuance and redemption"
+   isInternalTransfer: Boolean
+   "note attached to a portfolio movement or settlement.transferFunds call"
+   memo: String
+   "the account that signed the extrinsic"
+   address: String
    datetime: Date!
    createdBlock: Block!
    updatedBlock: Block!
    createdEvent: Event!
  }
```

`isInternalTransfer` is **not** indexed — `@index` is invalid on Boolean (§8b). Filter it as a plain equality; if it becomes a hot path, promote it to an enum, which *is* indexable.

### Why the flag is needed

Fair challenge: doesn't `eventId` already determine this? Mostly, but not in general:

- **`ControllerTransfer` has no same-DID guard.** In `base_controller_transfer` the destination is the caller's own holder and the source is arbitrary; nothing prevents both resolving to the same DID. The value maps to either answer.
- **`eventId` is an open set here.** In `processUpdateReason`, a `transferred` reason with no instruction id takes its `eventId` from `blockEvents[eventIdx + 1].event.method` — whatever event follows. A consumer cannot safely enumerate it.
- **Postgraphile cannot compare two columns**, so `fromIdentity = toIdentity` is not expressible as a filter.

Issuance and redemption remain derivable (`fromIdentityId: {isNull: true}` / `toIdentityId: {isNull: true}`), so the flag is null for those rather than restating them.

**Alternative considered:** a five-value enum (`Internal`/`External`/`Issuance`/`Redemption`/`Unknown`) — total classification and null-safe `notEqualTo`, at the cost of two values duplicating `eventId`. **[I]** Decide with the SDK team; the Boolean is the narrower change.

---

## Handler changes

Three handlers currently reach `PortfolioMovement` by two routes; funnel them through one writer:

| Handler | Event | `eventId` recorded |
|---|---|---|
| `handleFundsMovedBetweenPortfolios` | `portfolio.FundsMovedBetweenPortfolios` | `FundsMovedBetweenPortfolios` |
| `handlePortfolioMovement` | `portfolio.MovedBetweenPortfolios` | `MovedBetweenPortfolios` |
| `handleFundsTransferred` | `settlement.FundsTransferred` | `FundsTransferred` |

Holder-to-column splitting is duplicated today between `createAssetTransaction` and `mapAssetMovement`. Extract it to `src/utils/portfolios.ts` and share, so both writers classify a holder identically — the same helper [03](./03-holdings-nfts.md) extends for `HolderKind`.

**One subtlety to get right in review:** a holder that is *present* but whose DID never resolved (an account with no known Identity) must not be treated as an *absent* holder. Classification keys off holder presence first, then DID equality — otherwise an unresolved sender is silently recorded as an issuance.

---

## project.ts

No new registrations. `FundsMovedBetweenPortfolios`, `MovedBetweenPortfolios`, `FundsTransferred` are already handled; only their target entity changes.

### A8 — confirmed history gap, must be registered **[V]**

Both events were **declared and emitted** at v5.4.3, in `unchecked_move_funds` (`pallets/portfolio/src/lib.rs:767, 781`), and removed at v6.0.0:

```
FungibleTokensMovedBetweenPortfolios(IdentityId, PortfolioId, PortfolioId, Ticker, Balance, Option<Memo>)  — 6 args
NFTsMovedBetweenPortfolios(IdentityId, PortfolioId, PortfolioId, NFTs, Option<Memo>)                        — 5 args
```

They are **exclusive branches of a `match`, and `MovedBetweenPortfolios` is not emitted alongside them.** Neither is in `project.ts`. So any v5-era portfolio movement routed through `unchecked_move_funds` is absent from the index entirely.

The code path is confirmed. **The volume is not.**

### Counted — negligible **[V]**

Against the public dictionaries (mainnet synced to 25,337,651; testnet to 25,671,569):

| Event | Mainnet | Testnet |
|---|---|---|
| `FungibleTokensMovedBetweenPortfolios` | **0** | **0** |
| `NFTsMovedBetweenPortfolios` | **0** | **1** (block 7,786,536, spec 5003001) |
| `MovedBetweenPortfolios` (control) | 107 | 394 |
| `FundsMovedBetweenPortfolios` (control) | 12 | 539 |

**No mainnet history is missing.** One testnet event exists, in the v5 era as predicted.

So register the handlers for completeness and testnet parity, but this is **low priority** — it is not the data-correctness gap it looked like before counting. If handler budget is tight, this is the first thing to drop from the plan.

Note also how small this whole domain is: 119 portfolio movements on all of mainnet. Worth keeping in mind when weighing the `PortfolioMovement` merge — the merge is justified by model coherence and query shape, not by data volume.

```diff
  portfolio: {
+   FungibleTokensMovedBetweenPortfolios: ['handleFungibleTokensMovedBetweenPortfolios'],
+   NFTsMovedBetweenPortfolios: ['handleNftsMovedBetweenPortfolios'],
  }
```

Both write `AssetTransaction` rows with `isInternalTransfer: true`, the same as their v6+ successor. Note the differing arities (6 vs 5) and that the NFT variant carries an `NFTs` collection rather than a ticker/amount pair — each needs its own decoder entry.

### Versions that are fine

```
v5.4.3   MovedBetweenPortfolios(IdentityId, PortfolioId, PortfolioId, Ticker, Balance, Option<Memo>)   — 6, fungible only
v6.0.0+  FundsMovedBetweenPortfolios(IdentityId, PortfolioId, PortfolioId, FundDescription, Option<Memo>) — 5, polymorphic
```

Different event **names**, so no positional collision — already routed to separate handlers correctly **[V]**. `PortfolioCreated` and `PortfolioCustodianChanged` are stable across all tags.

---

## Tests

- **Unit:** holder classification, including the unresolved-DID case above.
- **Unit:** an intra-identity movement produces exactly one `AssetTransaction` with `isInternalTransfer: true` and matching from/to identities.
- **Unit:** `ControllerTransfer` where both sides resolve to the caller's DID is classified internal — the case `eventId` alone cannot decide.
- **Integration, assertion-based** (no pre-baked fixture needed):
  - every row classified internal has matching `fromIdentityId`/`toIdentityId`; every external row has both present and differing
  - `AssetTransaction` count for intra-identity events equals the historical `PortfolioMovement` count for the same block range

---

## Consumer impact — breaking

| Consumer | Query | Change needed |
|---|---|---|
| SDK | `portfolioMovements` | **Rewrite** to `assetTransactions` with `isInternalTransfer: { equalTo: true }`, or an equivalent `eventId` filter. |
| Portal | `portfolioMovements` | **Rewrite.** Currently filters `type: { equalTo: Fungible|NonFungible }` and orders `CREATED_BLOCK_ID_DESC`. The `type` split maps to `amount: { isNull: }` / `nftIds`, which is what its `assetTransactions` query already does. |
| Portal | `assetTransactions` | Gains intra-identity rows. Its existing `fromPortfolioId`/`toPortfolioId` OR-filter keeps working and now returns a complete picture. |

Both consumers query `portfolioMovements` **[V]**, so this needs coordinated releases. It is the only plan in the set where a portal change is mandatory.

**Note on `PortfolioMovementTypeEnum`:** removed with the entity. The Fungible/NonFungible distinction survives as `amount` vs `nftIds` being null, matching how `assetTransactions` already works.
