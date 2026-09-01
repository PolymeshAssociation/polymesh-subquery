# 12 — Types and CI gates

Chain types were not augmented, so most chain reads were `Codec` and every field access on one was unchecked. There was also no type-check gate anywhere in the build or CI, which is why that went unnoticed.

> **Prototyped 2026-09-01, then reverted.** No code has changed. The whole plan was built locally and run end-to-end — `lint`, `typecheck`, `build`, `test:unit` all green, 198 tests, 0 type errors, bundle loading all 188 handlers — and then backed out, so every number and every call site below is measured rather than estimated. §12.2 records what it actually took, which was considerably more than one import.

**Depends on:** nothing. This is the cheapest plan in the set and it makes every other plan safer to write.

---

## Problem

### 12.1 The API is typed, but not as Polymesh **[V]**

[`src/index.ts:4`](../../src/index.ts#L4) imports `@polkadot/api-augment` — the **generic Substrate** augmentation. `@polymeshassociation/polymesh-types` is a dependency (`^7.4.0`) but only its `typesBundle` is used, in [`src/chainTypes/index.ts`](../../src/chainTypes/index.ts). Its `polkadot/augment-api` declarations are never imported.

The consequence is not an error — it is the *absence* of errors. `QueryableStorage` carries an index signature, so `api.query.<anything>.<anything>()` type-checks and resolves to bare `Codec`:

```ts
// verified by compiling both ways
api.query.asset.assetNames('0x00')
//  without augmentation -> Codec
//  with    augmentation -> Option<Bytes>
```

Everything downstream then goes through `.toString()`, `.toJSON() as any`, `JSON.parse(...)` and hand-rolled shape guards — which is exactly the "shape knowledge lives in handler bodies" pattern `architecture-review.md` §2 identifies as the root cause of every version bug in the defect log. The decode layer in [09](./09-infrastructure.md) fixes that for **events**. This fixes it for **storage reads**.

Note the limit: the index signature means the augmentation does **not** catch a misspelled pallet or storage name. `api.query.nonexistentPallet.thing()` compiles with or without it **[V]**. What it buys is the *return* type and the *argument* types, which is where the real defects are.

### 12.2 What the augmentation actually costs — measured by applying it **[V]**

**Measured by building it.** The naive one-line version does *not* work, and the way it fails is the useful part — it is almost certainly why an earlier attempt at this was abandoned.

The finished version was verified green end-to-end (`lint`, `typecheck`, `build`, 198 unit tests, 0 type errors, bundle loads) before being reverted, so the costs below are observed, not projected.

Adding only `import '@polymeshassociation/polymesh-types/polkadot/augment-api'` beside the existing `@polkadot/api-augment`, and type-checking **without** `skipLibCheck`, produces **454 errors** in four distinct classes:

| Class | Count | Where | Cause |
|---|---|---|---|
| TS2305 / TS2724 | **277** | `polymesh-types/polkadot/augment-api-*.d.ts` | The `augment-api-*` files import their Polymesh types from `@polkadot/types/lookup`, which only carries them once **`types-lookup` has augmented that module**. Without that import the augmentation is largely inert |
| TS2717 | **122** | same files | `@polkadot/api-augment` and polymesh-types declare the **same members with different types** |
| TS2411 | **54** | `@polkadot/api-base/types/storage.d.ts` | `QueryableStorage` declares a `[key: string]: QueryableModuleStorage` index signature that no augmented pallet is assignable to |
| TS2694 | 1 | `@types/rimraf` | Pre-existing, unrelated |

Each needs a different answer.

**TS2305 — import `types-lookup` first.** One line, and it removes 274 of the 277:

```ts
import '@polymeshassociation/polymesh-types/polkadot/types-lookup';
import '@polymeshassociation/polymesh-types/polkadot/augment-api';
```

Order matters — `augment-api` reads types that `types-lookup` supplies. (polymesh-sdk achieves the same thing differently, by remapping `@polkadot/types/lookup` through tsconfig `paths`.)

**TS2717 — drop `@polkadot/api-augment`, and this one is not cosmetic.** It describes the generic Substrate **kitchensink** runtime. Loading it alongside the Polymesh augmentation makes both declare the same members, and TypeScript keeps the *first* declaration — so import order silently decides which chain your types describe. A sample of what actually differs:

```
Property 'asCall'        gasLimit  (kitchensink)  vs  weightLimit  (Polymesh)
Property 'asDispatchAs'  KitchensinkRuntimeOriginCaller  vs  PolymeshRuntimeDevelopRuntimeOriginCaller
```

With `api-augment` imported first, **161 members resolve to the wrong chain's types** and nothing reports it once `skipLibCheck` is on. That is a worse failure than having no augmentation at all, and it is the strongest argument for removing it rather than suppressing the conflict.

**But `@polkadot/api-augment` also has a runtime side effect**, and dropping it silently removes that too: its `base.js` requires `@polkadot/types-augment`, which registers the base Substrate type definitions. `@polkadot/api` does **not** load `types-augment` on its own — verified by requiring `@polkadot/api` alone and counting loaded modules: **0** **[V]**. So the import is replaced rather than deleted:

```ts
import '@polkadot/types-augment';   // runtime type registry; api-augment used to pull this in
```

**TS2411 — `skipLibCheck: true`.** Inherent to how polkadot-js augmentation works: the index signature and the augmented pallets cannot both be satisfied. polymesh-sdk sets the same flag for the same reason. It also covers a second `node_modules`-only class that appears once `api-augment` is gone — `@polkadot/api-derive` imports generic Substrate lookup types (democracy, society, bags-list) for pallets Polymesh does not have, so `types-lookup` never declares them (16 × TS2305).

**Project code type-checks clean with no suppression at all** — verified by running without `skipLibCheck` and filtering to `src/`: zero errors **[V]**. Every suppressed error is in `node_modules`.

### 12.2b The five project call sites it caught **[V]**

| # | Site | Error | Verdict |
|---|---|---|---|
| 1 | [`mapMultiSigProposal.ts`](../../src/mappings/entities/multiSig/mapMultiSigProposal.ts#L245) | `multiSig.proposalDetail` does not exist | **Correct.** Pre-7.x storage name, behind an `is7` branch → `legacyQuery` |
| 2 | [`genesisHandler.ts`](../../src/mappings/migrations/genesisHandler.ts#L160) | `multiSig.multiSigToIdentity` does not exist | **Correct.** Same → `legacyQuery` |
| 3 | [`assets.ts:22`](../../src/utils/assets.ts#L22) | `asset.customTypes(Codec)` where the map keys on `u32` | Real looseness → `getNumberValue(rawCustomId)` |
| 4 | [`mapAsset.ts:196`](../../src/mappings/entities/assets/mapAsset.ts#L196) | `asset.assetNames(Codec)` where the key is `PolymeshPrimitivesAssetAssetId` | Real looseness → `.toU8a()` |
| 5 | [`mapAsset.ts:197`](../../src/mappings/entities/assets/mapAsset.ts#L197) | `asset.fundingRound(Codec)` — same | Same |

4 and 5 only surface *after* `types-lookup` is imported: until then the key type was itself broken, so the call type-checked against nothing.

1 and 2 are the structural tension, and it is worth naming precisely:

> **`polymesh-types` augments one metadata — the current one. An indexer reads historical storage across every spec version the chain has ever had.**

So blanket augmentation is right for the overwhelming majority of reads and *must* have a deliberate escape hatch for storage that no longer exists. Rolling the augmentation back because of two legacy call sites trades a large, permanent win for a small, local one.

### 12.2c The latent hazard: two declaration files for one module **[V]**

`@polkadot/api-base` ships its declarations **twice** behind conditional exports, and both files exist on disk:

```jsonc
"./types/storage": {
  "module":  { "types": "./types/storage.d.ts" },      // and "default"
  "require": { "types": "./cjs/types/storage.d.ts" }
}
```

polymesh-types augments the **bare specifier** — `declare module '@polkadot/api-base/types/storage'` — so which physical file receives the augmentation depends on the resolution mode of the program doing the compiling. Verified with `--traceResolution`:

| `moduleResolution` | Resolves to |
|---|---|
| `node` (this repo's, via `module: commonjs`) | `types/storage.d.ts` |
| `node16` | `cjs/types/storage.d.ts` |

**Augmentation survives both**, because within one program the augmentation and its consumers resolve identically — checked under each mode, `asset.assetNames` types as `Option<Bytes>` either way **[V]**. The hazard is a **mixed-mode** build: one config augmenting one file while another reads the other, at which point the chain types vanish with no error. `moduleResolution` is therefore pinned explicitly in `tsconfig.json` with that reason recorded, rather than left to the `module: commonjs` default.

This is worth knowing because it is the shape of failure people expect from polkadot-js dual packaging — and here it is real, present, and *not* what was actually breaking.

### 12.3 Nothing type-checks the project **[V]**

| Gate | Command | What it actually checks |
|---|---|---|
| Lint | `eslint . --ext .ts` | **No types.** `.eslintrc` sets no `parserOptions.project`, so `@typescript-eslint` runs syntax-only rules |
| Build | `subql build` | Compiles, but runs `codegen` first, so it never sees a stale `src/types` |
| Test | `jest` / `jest --config jest.unit.config.js` | ts-jest diagnostics on the files a test imports |
| Type-check | — | **Does not exist.** There is no `typecheck` script |

`src/types` is **gitignored** — it is `subql codegen` output. So on a fresh checkout `tsc --noEmit` reports 11 errors that are purely missing generated models, and the first person to try it concludes type-checking is broken and stops. That is very likely the history behind "I tried augmenting types, it seemed to work, then the build failed."

Verified: after `yarn codegen`, `tsc --noEmit --skipLibCheck -p tsconfig.json` is **clean** **[V]**. Without `--skipLibCheck` there is one unrelated failure — `@types/rimraf` referencing a `glob` export that no longer exists — a transitive devDependency conflict, not project code.

This is almost certainly the history behind an earlier attempt at the augmentation being rolled back: on a fresh checkout the pre-existing 11 codegen errors and the 454 augmentation errors arrive together, in `node_modules` files nobody wrote, with no script that separates them.

---

## Design

### 12.4 Import the augmentation once, at the entry point

Three imports in [`src/index.ts`](../../src/index.ts), in this order, each for a different reason:

```ts
// runtime type registry; `@polkadot/api-augment` used to pull this in, and @polkadot/api does not
import '@polkadot/types-augment';
// must precede augment-api: it supplies the '@polkadot/types/lookup' types augment-api imports
import '@polymeshassociation/polymesh-types/polkadot/types-lookup';
import '@polymeshassociation/polymesh-types/polkadot/augment-api';
```

Global ambient augmentation applies program-wide once any file in the program imports it. `src/index.ts` is in the `include` of `tsconfig.json`, `tsconfig.test.json` and the build config, so one import covers every path **[V]** — confirmed by identical results under both configs, under `subql build`, and under ts-jest.

Two flags also need pinning in `tsconfig.json`, each with its reason recorded in a comment beside it: `skipLibCheck: true` (§12.2) and `moduleResolution: "node"` (§12.2c).

**Pin the version deliberately.** The augmentation reflects one metadata snapshot; `^7.4.0` will silently move it. Whether that is desirable is a judgement — a floating range means new storage appears without action, and also means a legacy read can start failing to compile on a patch bump. Record the choice in `package.json` with a comment either way; do not leave it accidental.

### 12.5 A typed escape hatch for historical storage

Errors 1 and 2 need one helper, not a `@ts-ignore`:

```ts
/**
 * Access a storage entry that does not exist in the metadata `polymesh-types` was generated
 * against — i.e. one the chain has since removed. The return is deliberately untyped: there
 * is no generated type for storage that no longer exists.
 *
 * @param specRange the spec versions this entry exists on, for the reader's benefit
 */
export const legacyQuery = (
  section: string,
  method: string,
  specRange: [number, number]
): QueryableStorageEntry<'promise'> => { ... };
```

```ts
// mapMultiSigProposal.ts
const query = is7
  ? api.query.multiSig.proposalStates
  : legacyQuery('multiSig', 'proposalDetail', [0, 6_999_999]);
```

Three properties worth having: every historical storage read becomes **greppable**, each one **states its spec range** next to itself, and the set is finite and shrinking — the same argument as the frozen legacy tuple table in [09](./09-infrastructure.md) §9.1, applied to storage instead of events.

This also feeds the `sync-metadata` script ([09](./09-infrastructure.md) §9.6): a `legacyQuery` whose range includes the current spec version is a bug, and that is a mechanical check.

### 12.6 Fix the argument-type looseness

Sites 3–5 are not legacy problems — they pass a raw `Codec` where the storage map declares a key type. Each should be decoded at the call site instead:

```ts
// assets.ts — customTypes keys on CustomAssetTypeId (u32)
const customType = await api.query.asset.customTypes(getNumberValue(rawCustomId));

// mapAsset.ts — assetNames/fundingRound key on a fixed-width codec: AssetId (16 bytes) on 7.x+,
// Ticker (12 bytes) before it. toU8a() is those exact bytes in both eras, so behaviour is unchanged.
api.query.asset.assetNames(rawAssetId.toU8a())
api.query.asset.fundingRound(rawAssetId.toU8a())
```

None changes runtime behaviour; each replaces an implicit coercion with an explicit one. All three were verified to compile and pass the existing suite. It becomes the compiler asking rather than a reviewer.

### 12.7 Add the missing gates

```jsonc
{
  "scripts": {
    "codegen": "./node_modules/.bin/subql codegen",
    "typecheck": "yarn codegen && tsc --noEmit -p tsconfig.test.json",
    "check": "yarn lint && yarn typecheck && yarn build && yarn test:unit"
  }
}
```

Notes on each decision:

- **`yarn codegen` first.** `src/types` is gitignored, so a type-check that does not regenerate it is checking a phantom. This is the single change that makes type-checking usable by anyone other than the person who last ran a build.
- **`tsconfig.test.json`, not `tsconfig.json`.** It includes `tests/**/*` as well as `src/**/*`, so the gate covers the test suite. `scripts/**` is currently in neither — it should be added to the test config's `include`, since [`ts-node.files`](../../tsconfig.json) was added in the authorization-payload work precisely so scripts see SubQuery's injected globals, and nothing type-checks them today.
- **`skipLibCheck` lives in `tsconfig.json`, not the script.** It is required by the augmentation itself (§12.2), not a convenience for this one gate, so every consumer of the tsconfig needs it. Project code still type-checks clean without it **[V]** — every suppressed error is in `node_modules`.
- **CI runs `yarn check`.** The current PR workflow runs lint, build and unit tests; adding `typecheck` between lint and build costs seconds.

### 12.8 Consider type-aware linting — separately, and later

`.eslintrc` has no `parserOptions.project`, so rules like `no-floating-promises`, `no-misused-promises` and `await-thenable` are inactive. In a codebase that pushes promises into arrays and `Promise.all`s them — the pattern throughout `mapNfts.ts`, `mapAsset.ts`, `mapSettlement.ts` — `no-floating-promises` is the rule most likely to find a real bug.

It is listed separately because turning it on will produce a large, unrelated diff, and it should not be bundled with a change whose value is that it is otherwise behaviour-neutral. **[I]** — the size of that diff has not been measured.

---

## Tests

The gate *is* the test. Three additions worth making beyond it:

1. A unit test asserting `legacyQuery` **throws** when the entry is absent from the block's metadata, rather than returning `undefined` and failing later at the call site. (An earlier draft of this plan proposed the opposite — a test that `legacyQuery` rejects storage the *current* metadata carries. That is wrong: on a pre-upgrade block the entry legitimately **is** in metadata, which is the whole reason for reading it. The staleness check belongs at build time, not runtime — see 2.)
2. The metadata-contract test in [09](./09-infrastructure.md) §9.1 extends naturally: for each checked-in `metadata.json`, assert every `legacyQuery` declared range excludes that spec version. A range that includes the current spec means the entry is live and `api.query.<section>.<method>` should be used instead.
3. A guard that `@polkadot/api-augment` is not reintroduced — a one-line grep in CI, or an ESLint `no-restricted-imports` rule. Re-adding it is a silent regression (§12.2), not a loud one.

---

## Consumer impact

None. No schema change and no query surface change.

**Runtime must be deliberately held constant**, and that takes one active step rather than zero: the augmentation itself is types-only and erased at compile time, but dropping `@polkadot/api-augment` would also drop its `@polkadot/types-augment` side effect, which nothing else loads **[V]**. Importing `@polkadot/types-augment` directly preserves it. Verified on the prototype: the built bundle referenced `types-augment` and not `api-augment`, loaded cleanly, and exported all 188 handlers **[V]**.

**The one thing worth validating against a live chain** before merging: that swapping `@polkadot/api-augment` for `@polkadot/types-augment` really is runtime-neutral during a sync. The unit suite mocks `api`, so it cannot see a registry difference.
