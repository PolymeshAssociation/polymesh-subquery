# Canonical event and call arguments: consumer migration

**For:** the SDK and portal maintainers deciding on plan 09 §9.10. **Branch:** `redesign/15-canonical-args` (stacked on `redesign/14-harvester-cleanup`, which leaves argument fields alone; its one consumer-visible change, to claims, is in [`consumer-queries.md`](./consumer-queries.md) §5). **Status:** built, not decided; nothing here is merged.

What changes, in one paragraph: `Event.attributesTxt`, `Event.attributes`, `Event.eventArg_0..3`, `Extrinsic.paramsTxt` and `Extrinsic.params` are removed. Every event and extrinsic carries `args` instead, a `jsonb` object in one encoding (the contract below), and every event has `references`: one `EventReference` row per identity, account, asset or portfolio found anywhere in its arguments. An event is found by what it involves with `references: { some: … }`, at any argument position, and by any other value with `args: { contains: … }`.

## The contract

Pinned by `tests/unit/argsContract.test.ts` against real mainnet blocks from v3 to v8.

| Value | Encoded as |
|---|---|
| any integer (`u8`…`u128`, `Compact`, `Balance`, `Moment`) | decimal **string**, never a JSON number |
| `AccountId` | SS58 address with the chain's prefix (`2…` on mainnet) |
| `IdentityId`, `AssetId`, hashes, memos, fixed byte arrays | `0x` hex, all of the bytes (a memo's text is on the entity that holds it, such as `Instruction.memo`) |
| `Ticker` | text without the trailing NULs that pad it to 12 bytes; `0x` hex of all 12 bytes when the rest is not NUL-free UTF-8 |
| `Bytes`, `Text` | UTF-8 text when valid and free of NUL, otherwise `0x` hex |
| struct | object keyed by field name, camelCased |
| tuple, `Vec`, fixed array, `BTreeSet` | array |
| enum | `{ "<Variant>": value }`, or the bare variant name for a unit variant (`"Default"`); variant names as the metadata spells them |
| `Option` | the value, or `null` |
| `Result` | `{ "ok": value }` / `{ "err": value }` |
| `BTreeMap`, `HashMap` | array of `[key, value]` pairs |
| `Call` | `{ "section", "method", "args" }` |

`args` itself is always an object, keyed by field name: the metadata's when it names every field (Substrate pallets' events, and Polymesh's own once a runtime declares them as structs), else the indexer's registered names for Polymesh's tuple-style events, which are the names the chain gives the same fields. An event the indexer has no names for at that spec version is keyed by position, `"0"`, `"1"`, …. Position keys make a positional filter possible: JSONB containment on an array would match a value at *any* position.

Before v7.0 the chain named assets by ticker, so a field that holds an `AssetId` from v7 held a `Ticker` before it. Its key says which: `ticker` up to v6, `assetId` from v7 (for example `asset.AssetBalanceUpdated`, `asset.Transfer`, the compliance, checkpoint and external-agent events). To find an asset's events across that change, use `references`, where a pre-v7 ticker is recorded under the asset id it maps to.

`EventReference.kind` is `Identity`, `Account`, `Asset` or `Portfolio`. `value` is the canonical encoding of what is referred to (`did/number` for a portfolio, `number` `0` for the default one); `argument` is the field name or position it was found in. A portfolio also refers to its identity. Before v7.0 a ticker refers to the asset it maps to; from v7.0 events name the asset itself.

## SDK

### `Network.getEventByIndexedArgs` / `getEventsByIndexedArgs` (`src/api/client/Network.ts`, `src/middleware/queries/events.ts`)

Today `eventsByArgs` filters `events` by `moduleId`, `eventId` and `eventArg0`–`eventArg2`, each an exact string match on the harvester encoding. Those columns are gone.

| Today | After |
|---|---|
| `events(filter: { moduleId: { equalTo: $moduleId }, eventId: { equalTo: $eventId }, eventArg0: { equalTo: $eventArg0 } })` | an identity, account, asset or portfolio: `events(filter: { moduleId: { equalTo: $moduleId }, eventId: { equalTo: $eventId }, references: { some: { kind: { equalTo: Identity }, value: { equalTo: $did } } } })` |
| `eventArg1: { equalTo: "<hex account>" }` | `references: { some: { kind: { equalTo: Account }, value: { equalTo: "<SS58 address>" } } }` — any position |
| `eventArg2: { equalTo: "5" }`, a value that is not a reference | `args: { contains: { "amount": "5" } }`, or `args: { contains: { "2": "5" } }` for an event keyed by position |

A suggested replacement for the two methods, keeping the old ones as thin wrappers for one release if that helps third parties:

```ts
getEvents(opts: {
  moduleId?: ModuleIdEnum;
  eventId?: EventIdEnum;
  involving?: { identity?: string; account?: string; asset?: string; portfolio?: string };
  args?: Record<string, unknown>;
  size?: BigNumber;
  start?: BigNumber;
  orderBy?: EventsOrderBy | EventsOrderBy[];
}): Promise<ResultSet<EventIdentifier>>
```

`involving` becomes `references: { some: { kind, value } }`; `args` becomes `args: { contains: … }`. Keep the `(moduleId, eventId)` filter whenever there is one: `args` is not indexed, so it is applied to the rows that pair narrows down to.

### `paramsTxt` (`src/middleware/queries/extrinsics.ts`, read in `Account/index.ts` and `Network.ts`)

| Today | After |
|---|---|
| select `paramsTxt`, then `params: JSON.parse(paramsTxt)` | select `args`; it arrives as an object, so no `JSON.parse` |
| balances as `toHuman` text, `"75.8040 mPOLYX"` | base units as a decimal string, `"75804"` |
| accounts as `toHuman` gave them | SS58 with the chain's prefix |

The keys are the metadata's argument names, camelCased (`assetId`, not `asset_id`).

### `params` in `src/middleware/queries/multisigs.ts`

That is `MultiSigProposal.params`, which this branch does not change.

## Portal

### `MultiSigTable/hooks.tsx`

| Today | After |
|---|---|
| `createdEvent.extrinsic.params` | `createdEvent.extrinsic.args` |
| `params.proposal.section` / `.method` / `.args` | unchanged: a `Call` encodes as `{ section, method, args }` |
| `new Date(params.expiry)` | `new Date(Number(args.expiry))`: an `Option<Moment>` is a decimal string of milliseconds, or `null` |
| the proposal's own arguments as `toHuman` text | the canonical encoding above: balances in base units, accounts SS58 |

## Examples

From `tests/fixtures/args/`.

**A named event** — `transactionPayment.TransactionFeePaid`, spec 8000020, block 25,131,384. Its `args`, and the `EventReference` rows it writes:

```json
{
  "args": {
    "who": "2FFrMvvspHLMZrsJoAhaiveSdZ3FBg3qkjktZQXdssANVFGX",
    "actualFee": "345251",
    "tip": "0"
  },
  "references": [
    {
      "kind": "Account",
      "value": "2FFrMvvspHLMZrsJoAhaiveSdZ3FBg3qkjktZQXdssANVFGX",
      "argument": "who"
    }
  ]
}
```

**A tuple-style event** — `identity.DidCreated`, spec 6002010, block 13,003,470. Polymesh's own events name no fields in this runtime's metadata, so the keys are the indexer's registered names for them; an event it has none for would be keyed `"0"`, `"1"`, …:

```json
{
  "args": {
    "did": "0x214121dbbe7d99159fdae9b309329bd9f942f3a01dbc09425bcf30caff7a69b7",
    "primaryKey": "2FiWTjFHNN2UDuS5TJve2Sg4XmEHXUFwzBqw8GVH46JguYCJ",
    "secondaryKeys": []
  },
  "references": [
    {
      "kind": "Identity",
      "value": "0x214121dbbe7d99159fdae9b309329bd9f942f3a01dbc09425bcf30caff7a69b7",
      "argument": "did"
    },
    {
      "kind": "Account",
      "value": "2FiWTjFHNN2UDuS5TJve2Sg4XmEHXUFwzBqw8GVH46JguYCJ",
      "argument": "primaryKey"
    }
  ]
}
```

**A portfolio, and the identity inside it** — `settlement.InstructionAutomaticallyAffirmed`, spec 8000020. The default portfolio's kind is a unit variant, so a bare name, and its reference is `did/0`:

```json
{
  "args": {
    "callerDid": "0xd80f141fae60babb8d22390a7a3de34ec37790991cbf5d44cb89dbbd39cce8ad",
    "holder": {
      "Portfolio": {
        "did": "0x586633505e39fffaee3785b212b04dd24c64f898b614a736bbecf53730850bda",
        "kind": "Default"
      }
    },
    "instructionId": "3792"
  },
  "references": [
    {
      "kind": "Identity",
      "value": "0xd80f141fae60babb8d22390a7a3de34ec37790991cbf5d44cb89dbbd39cce8ad",
      "argument": "callerDid"
    },
    {
      "kind": "Portfolio",
      "value": "0x586633505e39fffaee3785b212b04dd24c64f898b614a736bbecf53730850bda/0",
      "argument": "holder"
    },
    {
      "kind": "Identity",
      "value": "0x586633505e39fffaee3785b212b04dd24c64f898b614a736bbecf53730850bda",
      "argument": "holder"
    }
  ]
}
```

**A call** — `identity.cdd_register_did_with_cdd`, spec 6002010, as `Extrinsic.args`:

```json
{
  "targetAccount": "2FiWTjFHNN2UDuS5TJve2Sg4XmEHXUFwzBqw8GVH46JguYCJ",
  "secondaryKeys": [],
  "expiry": null
}
```
