# 01 — Claims

Fixes the only defect known to return silently wrong answers to a compliance code path.

**Entities:** `Claim` (changed), `ClaimScope` (removed), `CustomClaimType` (unchanged), `TrustedClaimIssuer` (relation fix).

---

## Problem

`Claim`'s id omits the issuer **[V]** ([`mapClaim.ts:43-61`](../../src/mappings/entities/identities/mapClaim.ts#L43)):

```ts
const idAttributes = [target, claimType];
if (customClaimTypeId) idAttributes.push(customClaimTypeId);
if (scope)  { idAttributes.push(scope.type); idAttributes.push(scope.assetId ?? scope.value); }
if (jurisdiction) idAttributes.push(jurisdiction);
if (cddId) idAttributes.push(cddId);
```

`handleClaimAdded` then calls `Claim.create({ id })`, which **overwrites**. The SDK filters `issuerId: { in: $trustedClaimIssuers }` and defaults to `revokeDate: { isNull: true }` **[V]**, producing two silent failures:

- **Lost claim** — issuers A and B both attest the same type/scope for one target; B overwrites A. A compliance check against A matches nothing.
- **Spurious revocation** — B revokes; `revokeDate` is set on the shared row; A's still-valid claim vanishes from every claims query.

---

## Target schema

```diff
  type Claim @entity {
    id: ID!
    eventIdx: Int! @index(unique: false)
    target: Identity! @index(unique: false)
    issuer: Identity! @index(unique: false)
    issuanceDate: BigInt!
    lastUpdateDate: BigInt!
    expiry: BigInt
    filterExpiry: BigInt! @index(unique: false)
    type: ClaimTypeEnum!
    jurisdiction: String
    scope: Scope
    cddId: String
    customClaimType: CustomClaimType
-   revokeDate: BigInt
+   "null while the claim stands. Set on revocation; a re-issue creates a NEW row."
+   revokeDate: BigInt
+   "block the claim was revoked in — null while active. Indexed for the `isNull` filter."
+   revokedBlock: Block @index
    createdBlock: Block! @index(unique: false)
    updatedBlock: Block!
    createdEvent: Event!
  }
```

Field shape is nearly unchanged. **The fix is the id**, plus treating re-issue as a new row.

### New id

```ts
const idAttributes = [target, issuer, claimType];   // ← issuer added
// … existing optional components unchanged …
```

**Open decision — collision vs. history.** Adding `issuer` fixes multi-issuer collision but a revoke → re-issue cycle by the *same* issuer still overwrites. Two options:

- **(a) `(target, issuer, type, …)`** — one row per issuer per claim. Current-state semantics; revoke/re-issue history still lost.
- **(b) `(target, issuer, type, …, createdBlockId, eventIdx)`** — append-only; every issuance is a row.

**Recommended: (a).** The SDK's query is a current-state question ("does T hold a valid claim from A?"), and (b) would require every consumer to add a "latest per group" filter they do not have today. Revocation history, if wanted later, belongs in a separate `ClaimEvent` log rather than by inflating the id.

**[I]** Worth confirming with a count before committing: how often does the same issuer revoke and re-issue the same claim to the same target? If common, reconsider (b).

### `ClaimScope` — remove

`ClaimScope { target, asset, scope }` duplicates `Claim.scope` (a jsonField) and is **unobserved by both consumers** **[V]**. The SDK filters scope via `scope: { contains: $scope }` on `Claim` directly.

Delete the entity and `processClaimScope`. If a scope-keyed lookup is ever needed, it is `groupedAggregates(groupBy: [SCOPE])` — though note jsonFields are not groupable (§8b), so that would need a materialised column, which is a reason to keep the door open rather than assume.

### `TrustedClaimIssuer` — relation

```diff
  type TrustedClaimIssuer @entity {
    asset: Asset! @index(unique: false)
-   issuer: String! @index(unique: false)
+   issuer: Identity! @index(unique: false)
  }
```

Consistent with `Claim.issuer`. Safe: the entity is queried by the SDK, but `issuerId` remains the column name so the filter shape is unchanged.

---

## Handler changes

**File:** `src/mappings/entities/identities/mapClaim.ts`

| Function | Change |
|---|---|
| `getId` | Add `issuer` as the second component. |
| `handleClaimAdded` | Take `issuer` from the decoded event (already extracted). Keep `Claim.create` — with the new id it no longer collides. Clear `revokeDate`/`revokedBlock` on re-issue. |
| `handleClaimRevoked` | Look up by the **issuer-scoped** id. Set `revokeDate` and `revokedBlock`. If no row is found, write an `IndexerAnomaly` rather than silently returning — today a missed lookup is invisible. |
| `processClaimScope` | Delete with `ClaimScope`. |
| `handleDidRegistered` | Unchanged. |

`extractClaimInfo` in `generatedColumns.ts` already surfaces `claimIssuer`; confirm it is the DID and not the raw codec before use.

---

## project.ts

No change. `ClaimAdded`, `ClaimRevoked`, `CustomClaimTypeAdded`, `AssetDidRegistered` are already handled.

Worth checking during implementation: `identity.CddClaimsInvalidated` is `[]`. It is a compliance-relevant state change and plausibly belongs here — **[I]** confirm what it does to claim validity on chain before deciding.

---

## Tests

- **Unit:** `getId` produces different ids for two issuers with identical target/type/scope.
- **Unit:** revoke by issuer B leaves issuer A's row untouched — the regression test for the reported bug.
- **Unit:** re-issue after revoke clears `revokeDate`.
- **Integration:** a target with claims from two trusted issuers returns both; filtering by one issuer returns exactly that one.
- **Contract:** `ClaimAdded` arity asserted for each supported spec range.

---

## Consumer impact

| Consumer | Query | Impact |
|---|---|---|
| SDK | `claimsQuery` | **Behaviour change, no shape change.** Returns claims that were previously lost. Filtering by `trustedClaimIssuers` starts working correctly. |
| SDK | `claimsGroupingQuery` | `groupBy: [TARGET_ID]` unchanged; result set may grow now that per-issuer rows survive. |
| SDK | `didsWithClaims` / `issuerDidsWithClaimsByTarget` | Same — more complete results. |
| SDK | `ClaimScope` | Not queried **[V]** — removal is safe. |
| Portal | — | No claims queries. Unaffected. |

No consumer needs a code change. Results become correct where they were previously incomplete, which is worth flagging to the SDK team explicitly: **counts will go up after the resync**, and that is the fix landing, not a regression.
