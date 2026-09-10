# 04 — Identity & keys

Models key membership as an explicit, time-bounded relationship instead of a mutable pointer plus a loose log.

**Entities:** `IdentityKey` (new), `AccountHistory` (removed), `Permissions` entity (removed — collapsed into the jsonField), `Identity`/`Account`/`MultiSig`/`MultiSigAdmin`/`MultiSigSigner` (relations), `Account.keyRole` (new), `ChildIdentity` (retirement, already landed in [09](./09-infrastructure.md)).

**Depends on:** [09](./09-infrastructure.md) — `ChainUpgrade` drives the `ChildIdentity` retirement (already implemented there). The decode layer from [09](./09-infrastructure.md) is used by every identity handler.

**Status:** implemented as `redesign/06-identity-keys`, a parallel track off `redesign/03-infrastructure` (developed alongside phases 4/5/8, rebased before merge).

---

## Problem

- **G1 — `Identity.secondaryAccounts` includes the primary account** **[V]**. It derives from `Account.identity`, and `handleDidCreated` sets `identityId` on the primary account too. `Account` had no `role` discriminator, so consumers could not filter it out. *(Fixed: field removed; `keys(filter: …)` replaces it.)*
- **G2 — `primaryAccount: String!`** while `Account.identity` is a relation. No FK, no join. *(NOT addressed in this phase — `primaryAccount` stays a string; the relation is reachable via `keys(filter: { role: { equalTo: Primary } })`. Turning `primaryAccount` itself into a relation is a follow-up.)*
- **G3 — no key-rotation history.** `PrimaryKeyUpdated` overwrites in place; `AccountHistory` has untyped `String` columns and no validity interval. Rotations cannot be listed, counted, or aggregated. *(Fixed: `IdentityKey`.)*
- **G4 — `Permissions` entity and `PermissionsJson` jsonField duplicate the same four fields.** *(Fixed: entity removed, permissions live on `IdentityKey.permissions`.)*
- **G5 — `MultiSig` is not linked to its `Account`**, despite a multisig *being* an account. *(Fixed: `MultiSig.account`, `MultiSigAdmin.admin`.)*
- **G6/A11 — `ChildIdentity` holds rows for a feature the chain deleted** in a silent v8 storage migration **[V]**. *(Already handled in [09](./09-infrastructure.md) — `retireChildIdentitiesAtV8`.)*
- **G16 — signer keys and account role are not modelled** **[V]**. `MultiSigSigner.signerValue` is unindexed and unjoinable to `Account`, and `Account` records the key's cryptographic shape (`keyType`) but not its role in the identity system, even though the chain's `KeyRecord` distinguishes primary / secondary / multisig-signer keys and the indexer reads that via `resolveKeyIdentity` before discarding it. *(Fixed: `Account.keyRole: KeyRoleEnum`, `MultiSigSigner.signerAccount: Account`.)*
- **`MultiSig.creator` conflated creator and admin** **[V]**. `genesisHandler.ts` filled it from `multiSig.adminDid` storage — the current **admin** — for genesis-seeded rows; `mapMultiSig.ts` fills it from the `MultiSigCreated` event's `callerDid` — the **creator** — for everything after. *(Fixed — see "MultiSig identity relationships" below.)*

---

## Target schema

As shipped. Composite indexes use the relation field name (`account`, not `accountId`) — codegen
rejects the FK column name there.

```graphql
type Identity @entity {
  id: ID!                        # did
  did: String! @index(unique: true)
  primaryAccount: String! @index(unique: false)   # G2 not addressed — still a string
  secondaryKeysFrozen: Boolean!
  "all key assignments, current and historical — replaces the removed secondaryAccounts"
  keys: [IdentityKey!]! @derivedFrom(field: "identity")
  createdBlock: Block!
  updatedBlock: Block!
}

"""
One row per (account, identity, role) membership interval. Append-only:
a rotation / permissions change closes the old row and opens a new one.
Replaces AccountHistory and Identity.secondaryAccounts.
"""
type IdentityKey @entity
  @compositeIndexes(fields: [["identity", "role"], ["account", "validToBlock"]]) {
  id: ID!                        # did/address/padId(fromBlock)/padId(eventIdx)  — D4
  identity: Identity! @index
  account: Account! @index
  role: KeyRole!
  permissions: PermissionsJson   # null for a primary key (always full permission)

  validFromBlock: Block!
  "null = currently active. Filter `validToBlockId: { isNull: true }` (Boolean cannot be indexed, §8b)"
  validToBlock: Block @index
  addedReason: EventIdEnum!
  removedReason: EventIdEnum
  createdBlock: Block!
  updatedBlock: Block!
}

enum KeyRole { Primary  Secondary }

"""
The key's role in the identity system, from the chain's KeyRecord — distinct from keyType
(the cryptographic shape). Open set: Unlinked currently covers pallet/pot/detached keys as one.
"""
enum KeyRoleEnum { PrimaryKey  SecondaryKey  MultiSigSigner  Unlinked }

type Account @entity {
  id: ID!                        # address
  address: String! @index(unique: true)
  keyType: String!               # substrate | ethereum — unchanged
  keyRole: KeyRoleEnum! @index(unique: false)     # NEW — the key's role, mutable
  evmAddress: String @index(unique: false)
  identity: Identity             # current identity, for convenience
  keyAssignments: [IdentityKey!]! @derivedFrom(field: "account")
  "set when this account is a multisig — the account IS the multisig"
  multiSig: MultiSig @derivedFrom(field: "account")
  createdBlock: Block!
  updatedBlock: Block!
}

type MultiSig @entity {
  id: ID!                        # address
  account: Account! @index(unique: true)          # relation, not a bare string (was: address)
  creator: Identity              # NULLABLE — MultiSigCreated.callerDid only; null for genesis rows
  creatorAccount: Account        # NULLABLE — the event's caller account; null for genesis rows
  signaturesRequired: Int!
  admins: [MultiSigAdmin!] @derivedFrom(field: "multisig")   # the admin relationship lives here
  signers: [MultiSigSigner]! @derivedFrom(field: "multisig")
}

type MultiSigAdmin @entity {
  id: ID!
  multisig: MultiSig! @index(unique: false)
  admin: Identity! @index(unique: false)          # was: identityId: String!
  status: MultiSigAdminStatusEnum!
}

type MultiSigSigner @entity {
  id: ID!
  multisig: MultiSig! @index(unique: false)
  signerType: SignerTypeEnum!
  signerValue: String!                            # KEPT — canonical; Identity signers exist pre-7.x
  signerAccount: Account @index(unique: false)    # NEW, NULLABLE — set only for Account signers
  status: MultiSigSignerStatusEnum!
}
```

### Removals

| Entity/field | Rationale |
|---|---|
| `AccountHistory` | Subsumed by `IdentityKey`, which adds the validity interval it lacks. Unobserved by both consumers **[V]**. |
| `Permissions` (entity) | Collapsed into `IdentityKey.permissions` using the existing `PermissionsJson` jsonField, removing the duplicate shape (G4). `Account.permissions` gone. Unobserved by both consumers **[V]**. |
| `Identity.secondaryAccounts` | Semantics were wrong (G1) and `@derivedFrom` takes no filter, so it could not be corrected in place. **Removed.** Current secondary keys: `keys(filter: { role: { equalTo: Secondary }, validToBlockId: { isNull: true } })`. |
| `MultiSig.address` | Replaced by the `account` relation. |

**Safe to remove `secondaryAccounts`** — verified the SDK reads secondary keys from **chain** (`polymeshApi.query.identity`, `src/api/entities/Identity/index.ts:865+` on `origin/develop`), not from middleware **[V]**.

### MultiSig identity relationships — resolved by chain research

A multisig has **four distinct identity relationships**, verified against `multiSig` pallet storage
(`types-lookup` / `augment-api-query`, chain 8.0.1):

| Relationship | Chain source | Mutable? | This index |
|---|---|---|---|
| **creator** — dispatched `create_multisig` | `MultiSigCreated.callerDid` event param **only** (no storage) | no, but unrecoverable if not observed | `MultiSig.creator` — **nullable**, event-only; null for genesis rows |
| **admin** — "primary key of this identity has admin control" | `multiSig.adminDid: Option<IdentityId>`; `add_admin`/`remove_admin` | yes | `MultiSigAdmin` rows (`MultiSig.admins`), status-tracked |
| **paying** — "primary key of this identity pays the proposal fees" | `multiSig.payingDid: Option<IdentityId>`; only a `MultiSigRemovedPayingDid` event | yes | **not indexed** — newly-found gap, see below |
| **joined** — the multisig account attached to an identity as a key | `identity.keyRecords(multisigAddr)` → `SecondaryKey(did)` | yes (unlink/rejoin) | `Account.identity` on the multisig's own account (commit 6) |

Pre-7.x `create_multisig` set `MultiSigToIdentity` (renamed `adminDid` at 7.0) to the caller, so
creator and admin coincided — that is where the old single `creator` field came from. Post-7.x they
are independent.

**Change:** `MultiSig.creator` / `creatorAccount` become nullable and are populated **only** from
`MultiSigCreated`. `genesisHandler.handleMultiSigs` stops writing `creator` from `adminDid` and
instead always seeds a `MultiSigAdmin` row from `adminDid` / `multiSigToIdentity` (it previously
skipped that on the pre-7 path — a bug).

**Newly-found gap (not fixed here):** `multiSig.payingDid` is entirely unindexed — `project.ts` has
`MultiSigRemovedPayingDid: []` and there is no "paying did set" event, so forward population needs a
storage read on `MultiSigCreated` / `join_identity`. Belongs with the multisig event-shape sweep
(`defect-log.md`).

### Open questions — resolved by chain research

| Question | Answer |
|---|---|
| `MultiSigSigner.signerAccount` nullable or non-null? | **Nullable — forced, not a preference.** `multiSig.multiSigSigners` is keyed by `AccountId32` in v8, but `SignerTypeEnum` is `Account \| Identity` and pre-7.x `Signatory` signers could be an identity (the `is7xChain` branch in `getMultiSigSigners` still parses both). A relation cannot point at an identity, and the index replays from genesis, so a non-null `signerAccount` would be impossible for those rows. `signerValue` stays canonical. |
| Should `KeyRoleEnum.Unlinked` split? | **No — the chain has no finer distinction.** `KeyRecord` is a closed three-variant enum (`PrimaryKey` / `SecondaryKey` / `MultiSigSignerKey`); every other address is simply `None`. Pallet addresses, system pots, brand-new addresses and deliberately-detached keys are indistinguishable *from chain state*. A future split (`SystemAccount` for known `PalletId`-derived addresses via `systematicIssuers`, `Detached` for an address with a closed `IdentityKey` interval and no open one, `Unlinked` for the rest) would be an **indexer-side heuristic over data the index already has** — worth doing only if a consumer asks. The enum is left open (nothing marks it exhaustive) so that stays cheap. |
| Should `MultiSig.creator` split into `creator` / `admin` / joined-identity? | **Yes — done** (see "MultiSig identity relationships" above). The chain models them as separate, independently-`Option`al, mostly-mutable relationships, plus a fourth (`payingDid`). `creator` is now nullable and event-only; `admin` is `MultiSig.admins`; joined-identity is `account.identity`; `payingDid` is a noted gap. |

### `ChildIdentity`

Already retired at the v8 boundary in [09](./09-infrastructure.md) (`retireChildIdentitiesAtV8`, driven off the persisted `ChainUpgrade` comparison). No further work here.

---

## Handler changes

**File:** `src/mappings/entities/identities/mapIdentities.ts`

| Handler | Change |
|---|---|
| `handleDidCreated` | Open a `Primary` `IdentityKey`; `createAccount` with `keyRole: PrimaryKey`. Stop writing a `Permissions` row. |
| `handleSecondaryKeysAdded` | Open `Secondary` `IdentityKey` rows with the granted permissions; `createAccount` with `keyRole: SecondaryKey`. |
| `handleSecondaryKeysRemoved` | Close the matching rows (`validToBlock`, `removedReason`). (Still `Account.remove`s the row — a pre-existing behaviour left unchanged; see PR.) |
| `handleSecondaryKeyLeftIdentity` | Close the row; null `identityId` **and** set `keyRole: Unlinked` in the same write. |
| `handleSignerLeft` | Close the row. |
| `handleSecondaryKeysPermissionsUpdated` | Close the current row and open a new one with the new permissions — permission changes become first-class history. No longer mutates a `Permissions` row. |
| `handlePrimaryKeyUpdated` | Close the old `Primary` row, open a new one, update `Identity.primaryAccount`. Old key gets `keyRole: Unlinked` on the same write. **This is the rotation record G3 asks for.** |
| `getOrCreateAccount`, `ledgerAccount` (`src/utils/accounts.ts`) | Set `keyRole` from the key record. `ledgerAccount` moved here from `mapPolyxLedger.ts` (a general account helper). `keyRoleFor` / `resolveKeyRole` are the single derivation point. |
| `handleChildDidCreated` / `handleChildDidUnlinked` | Unchanged — pre-v8 only. |

**The pre-5.0 payload unwrapping** (`instanceof Map`, `'key' in rest`, `'signer' in rest`) is relocated verbatim from the handlers into `src/decode/legacy.ts` (`SIGNATORY_WRAPPERS_REMOVED_AT = 5_000_000`). Arity is unchanged across every version, so it is not a shape-registry entry; the module holds the fact of *what* changed at 5.0, the logic is untouched.

### Version work — verified, and smaller than expected **[V]**

All identity events are **stable in arity and type across v5.4.3 → v8.0.0**: `DidCreated` (3), `SecondaryKeysAdded` (2), `SecondaryKeysRemoved` (2), `SecondaryKeyPermissionsUpdated` (4), `PrimaryKeyUpdated` (3), `SecondaryKeysFrozen`/`Unfrozen` (1), `ChildDidCreated` (3).

The only boundary is **pre-5.0**, and the existing duck-typed branches are handling a real change:

```
v4.1.3       SecondaryKeysRemoved(IdentityId, Vec<Signatory<AccountId>>)
v5.0.0-rc1+  SecondaryKeysRemoved(IdentityId, Vec<AccountId>)

v4.1.3       SecondaryKeyPermissionsUpdated(IdentityId, SecondaryKey<AccountId>, Permissions, Permissions)
v5.0.0+      SecondaryKeyPermissionsUpdated(IdentityId, AccountId,               Permissions, Permissions)
```

Arity is unchanged; the payload *types* changed. So `rawSignerDetails instanceof Map` / `'key' in rest` vs `'signer' in rest` are **correct** — move them into the legacy decoder table with the boundary at `5_000_000` rather than leaving them as inline shape sniffs.

`AssetDidRegistered(IdentityId, Ticker)` is present v5.4.3 → v7.4.0 and **gone at v8.0.0** **[V]**. It stays handled for history; it simply never fires post-v8. No action, but worth a comment so it is not mistaken for a coverage gap.

**File:** `src/mappings/entities/multiSig/mapMultiSig.ts`

- `createMultiSig` creates the multisig's own `Account` (`ledgerAccount`) and links `MultiSig.account`; `MultiSigAdmin.identityId` → `admin` relation.
- The signer-creation sites (`handleMultiSigCreated`, `handleMultiSigSignerAuthorized`, `handleMultiSigSignersAuthorized`, `createMultiSigSigner`) resolve `MultiSigSigner.signerAccount` via `linkSignerAccount` — only for `Account` signers — which also creates the signer's bare `Account` with `keyRole: MultiSigSigner`. Not done inside `getOrCreateAccount`: the event carries the real block/datetime and `status`.
- `getMultiSigSigner(s)` in `src/utils/multisigs.ts` still branches on `is7xChain` **[V]**. The multisig handlers keep their existing version-aware positional decoding — moving them behind `decodeEvent` needs a `src/decode/shapes/multiSig.ts` shape table, which is **deferred** (a separate change).

**Seed scan:** `genesisHandler.handleMultiSigs` is the seeder (seed domain #4 per [10](./10-partial-index.md)). It now threads `datetime` and goes through `createMultiSig` / `createMultiSigSigner`, so genesis-seeded rows get the `account`/`signerAccount` links and `keyRole` authoritatively from `multiSig.multiSigSigners` + `identity.keyRecords`. `handleGenesisDids` sets `keyRole` (`PrimaryKey` for index 0, `SecondaryKey` otherwise).

---

## project.ts

```diff
  identity: {
-   AuthorizationRetryLimitReached: [],
+   AuthorizationRetryLimitReached: ['handleAuthorization'],
  }
```

`AuthorizationRetryLimitReached` carries the same `(Option<IdentityId>, Option<AccountId>, u64)` shape as the other authorization-outcome events; it rides `handleAuthorization` and marks the row with a new terminal `AuthorizationStatusEnum.RetryLimitReached`.

`CddClaimsInvalidated`: **left `[]`**. It is a CDD-claims concern (it invalidates the CDD claims issued by a provider whose own CDD was revoked, as of a moment), not a key concern, and it is absent from the v8 runtime. It belongs with [01](./01-claims.md); not forced in here. `project.ts` carries a comment.

---

## Tests (unit — the redesign is unit-gated)

- `tests/unit/mapIdentityKey.test.ts` — open/close/rotate; add→remove→re-add produces a two-interval history with no gap or overlap (the old interval's `validToBlock` equals the new one's `validFromBlock`); G1 regression (a primary and secondary filter apart by role); G4 (permissions ride the row).
- `tests/unit/mapMultiSig.test.ts` — `MultiSig.account` is joinable; `MultiSigAdmin.admin` is a relation; `signerAccount` set for `Account` signers (keyRole forced to `MultiSigSigner`), null for `Identity` signers.
- `tests/unit/keyRole.test.ts` — `keyRoleFor` for each of the four `KeyRecordResolution` cases, including that a multisig's own account keyed as a secondary key reads `SecondaryKey`.
- `tests/unit/mapIdentities.test.ts` — `SecondaryKeyLeftIdentity` nulls `identityId` and sets `keyRole: Unlinked` in the same write.
- `tests/unit/mapAuthorization.test.ts` — `AuthorizationRetryLimitReached` marks the row `RetryLimitReached`; tolerates a missing row.
- `tests/entities/identities.test.ts` — updated to `keys(filter: …)`; asserts no returned key is the primary. Runs on the next full resync.

---

## Consumer impact

| Consumer | Query | Impact |
|---|---|---|
| SDK | — | `Identity` and `Account` have **no root query field** in either consumer **[V]**; they are reached via relations. Relations are preserved. |
| SDK | `authorizations` | Unaffected — a new `AuthorizationStatusEnum` value is additive. |
| SDK | `multiSigProposals`, `multiSigProposalVotes` | Unaffected — `MultiSigProposal` / `MultiSigProposalVote` shapes unchanged. |
| Portal | `multiSigProposals` | Unaffected. |
| Both | `Permissions`, `AccountHistory`, `MultiSig`, `MultiSigAdmin`, `MultiSigSigner`, `ChildIdentity` | Not directly queried per `consumer-queries.md` **[V]** — removals and relation changes are low external risk. `MultiSigSigner` gains a field (`signerAccount`); adding a nullable field to an unqueried entity does not change the "unobserved" conclusion. |
| Both | `Identity.secondaryAccounts` | Removed. SDK reads secondary keys from chain, not middleware **[V]**, so low external risk; any middleware consumer must move to `keys(filter: …)`. |

It touches many entities but almost nothing either consumer queries. Worth re-confirming no external consumer reads `AccountHistory` / `secondaryAccounts` before merge, since "unobserved" means unobserved in the two known repos.
