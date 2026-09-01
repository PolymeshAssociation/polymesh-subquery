# 04 — Identity & keys

Models key membership as an explicit, time-bounded relationship instead of a mutable pointer plus a loose log.

**Entities:** `IdentityKey` (new), `AccountHistory` (removed), `Identity`/`Account`/`MultiSig` (relations), `Permissions` (collapsed), `ChildIdentity` (retirement).

**Depends on:** [09](./09-infrastructure.md) — `ChainUpgrade` drives the `ChildIdentity` retirement.

---

## Problem

- **G1 — `Identity.secondaryAccounts` includes the primary account** **[V]**. It derives from `Account.identity`, and `handleDidCreated` sets `identityId` on the primary account too ([`mapIdentities.ts:189-196`](../../src/mappings/entities/identities/mapIdentities.ts#L189)). `Account` has no `role` discriminator, so consumers cannot filter it out.
- **G2 — `primaryAccount: String!`** while `Account.identity` is a relation. No FK, no join.
- **G3 — no key-rotation history.** `PrimaryKeyUpdated` overwrites in place; `AccountHistory` has untyped `String` columns and no validity interval. Rotations cannot be listed, counted, or aggregated.
- **G5 — `MultiSig` is not linked to its `Account`**, despite a multisig *being* an account.
- **G6/A11 — `ChildIdentity` holds rows for a feature the chain deleted** in a silent v8 storage migration **[V]**.

---

## Target schema

```graphql
type Identity @entity {
  id: ID!                        # did
  did: String! @index(unique: true)
  "current primary — a relation, not a string"
  primaryKey: Account!
  secondaryKeysFrozen: Boolean!
  keyCount: Int!
  "all key assignments, current and historical"
  keys: [IdentityKey!]! @derivedFrom(field: "identity")
  # secondaryAccounts removed — see below
  createdBlock: Block!
  updatedBlock: Block!
}

"""
One row per (account, identity, role) membership interval. Append-only:
a rotation closes the old row and opens a new one.
Replaces AccountHistory, Identity.primaryAccount and Identity.secondaryAccounts.
"""
type IdentityKey @entity @compositeIndexes(fields: [["identityId", "role"], ["accountId", "validToBlockId"]]) {
  id: ID!                        # did/address/padId(fromBlock)  — D4
  identity: Identity! @index
  account: Account! @index
  role: KeyRole!
  permissions: PermissionsJson

  validFromBlock: Block!
  "null = currently active. Filter `validToBlockId: { isNull: true }` (Boolean cannot be indexed, §8b)"
  validToBlock: Block @index
  addedReason: EventIdEnum!
  removedReason: EventIdEnum
}

enum KeyRole { Primary, Secondary }

type Account @entity {
  id: ID!                        # address
  address: String! @index(unique: true)
  identity: Identity             # current identity, for convenience
  "set when this account is a multisig — the account IS the multisig"
  multiSig: MultiSig
  keyAssignments: [IdentityKey!]! @derivedFrom(field: "account")
  createdBlock: Block!
  updatedBlock: Block!
}

type MultiSig @entity {
  id: ID!                        # address
  account: Account!              # relation, not a bare string
  creator: Identity!
  signaturesRequired: Int!
  admins: [MultiSigAdmin!]! @derivedFrom(field: "multisig")
  signers: [MultiSigSigner!]! @derivedFrom(field: "multisig")
}

type MultiSigAdmin @entity {
  id: ID!
  multisig: MultiSig! @index(unique: false)
- identityId: String!
+ admin: Identity!               # matches MultiSig.creator
  status: MultiSigAdminStatusEnum!
}
```

### Removals

| Entity/field | Rationale |
|---|---|
| `AccountHistory` | Subsumed by `IdentityKey`, which adds the validity interval it lacks. Unobserved by both consumers **[V]**. |
| `Permissions` (entity) | Collapses into `IdentityKey.permissions` using the existing `PermissionsJson` jsonField, removing the duplicate shape (G4). Unobserved by both consumers **[V]**. |
| `Identity.secondaryAccounts` | Semantics were wrong. Replaced by `keys(filter: { role: SECONDARY, validToBlockId: { isNull: true } })`. |

**Safe to remove `secondaryAccounts`** — verified the SDK reads secondary keys from **chain** (`polymeshApi.query.identity`, `src/api/entities/Identity/index.ts:865+` on `origin/develop`), not from middleware **[V]**.

### `ChildIdentity`

Keep the entity for pre-v8 history, but **retire the rows at the v8 boundary** (A11). Driven from `ChainUpgrade`: on the first block with `specVersion >= 8_000_000`, delete all `ChildIdentity` rows.

Must not be a module-level flag — it has to be deterministic under `--workers` and across restarts, which is why it hangs off persisted upgrade state.

---

## Handler changes

**File:** `src/mappings/entities/identities/mapIdentities.ts`

| Handler | Change |
|---|---|
| `handleDidCreated` | Create `Identity` with `primaryKey`; create `Account`; open an `IdentityKey` with `role: Primary`. Stop writing a separate `Permissions` row. |
| `handleSecondaryKeysAdded` | Open `IdentityKey` rows with `role: Secondary` and the granted permissions. |
| `handleSecondaryKeysRemoved` | Close the matching rows (`validToBlock`, `removedReason`). |
| `handleSecondaryKeyLeftIdentity` / `handleSignerLeft` | Close the row. |
| `handleSecondaryKeysPermissionsUpdated` | Close the current row and open a new one with the new permissions — permission changes become first-class history. |
| `handlePrimaryKeyUpdated` | Close the old `Primary` row, open a new one, update `Identity.primaryKey`. **This is the rotation record G3 asks for.** Also drop the `[rawDid, , newKey]` positional destructure in favour of named-field decode ([09](./09-infrastructure.md)). |
| `handleChildDidCreated` / `handleChildDidUnlinked` | Unchanged — pre-v8 only; the events do not exist at v8 **[V]**. |

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

**File:** `src/mappings/entities/multiSig/mapMultiSig.ts` — link `MultiSig.account`; change `MultiSigAdmin.identityId` to the `admin` relation. `getMultiSigSigner(s)` in `src/utils/multisigs.ts` already branches on `is7xChain` **[V]**; leave that logic, move it behind the decode layer.

---

## project.ts

```diff
  identity: {
-   CddClaimsInvalidated: [],
+   CddClaimsInvalidated: ['handleCddClaimsInvalidated'],       # compliance-relevant
-   AuthorizationRetryLimitReached: [],
+   AuthorizationRetryLimitReached: ['handleAuthorizationRetryLimitReached'],
  }
```

**[I]** Confirm what `CddClaimsInvalidated` does to claim validity on chain before implementing — it may belong in [01](./01-claims.md) instead.

---

## Tests

- **Unit:** `handleDidCreated` produces exactly one `IdentityKey` with `role: Primary`.
- **Unit:** querying active secondary keys never returns the primary — the G1 regression test.
- **Unit:** `PrimaryKeyUpdated` closes the old row and opens a new one; both remain queryable, and the old row's `validToBlock` equals the new one's `validFromBlock`.
- **Unit:** a permissions update closes and reopens rather than mutating.
- **Unit:** crossing spec 7_004_001 → 8_000_000 empties `ChildIdentity` (A11).
- **Integration:** for a sample identity, active `IdentityKey` rows match `api.query.identity` chain state at the same block.

---

## Consumer impact

| Consumer | Query | Impact |
|---|---|---|
| SDK | — | `Identity` and `Account` have **no root query field** in either consumer **[V]**; they are reached via relations. Relations are preserved. |
| SDK | `authorizations` | Unaffected. |
| SDK | `multiSigProposals`, `multiSigProposalVotes` | Unaffected — `MultiSigProposal` shape unchanged. |
| Portal | `multiSigProposals` | Unaffected. |
| Both | `Permissions`, `AccountHistory`, `MultiSig`, `MultiSigAdmin`, `MultiSigSigner`, `ChildIdentity` | Unobserved **[V]** — removals and relation changes are low-risk. |

Lowest-risk structural change in the review: it touches many entities but almost nothing consumers query. Worth confirming no external consumer reads `AccountHistory` before deleting it, since "unobserved" means unobserved in the two known repos.
