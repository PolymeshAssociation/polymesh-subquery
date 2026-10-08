import type { AnyJson } from '@polkadot/types/types';

/**
 * The chain's own `RewardDestination` variants, plus the placeholder recorded when the payee
 * cannot be read at all.
 *
 * Spelled out rather than derived from `PalletStakingRewardDestination['type']`: `src/index.ts`
 * loads both `polymesh-types` and `@polkadot/types-augment`, and each declares that interface
 * into `@polkadot/types/lookup`. The duplicate declaration collapses `type` to a bare `string`
 * (the conflict is in `node_modules`, so `skipLibCheck` hides it) — `is*`/`as*` survive it,
 * `type` does not — so deriving the union would silently widen it back to `string`.
 */
export type RewardDestinationName =
  | 'Staked'
  | 'Stash'
  | 'Controller'
  | 'Account'
  | 'None'
  | 'LegacyUnknown';

export interface LegacyRewardDestination {
  rewardDestination: RewardDestinationName;
  /** The account the reward was actually paid to, where it can be resolved */
  rewardDestinationAccount?: string;
}

/** `.toJSON()` camel-cases the variant name; this maps it back to the name the index records. */
const rewardDestinationByVariant: Record<string, RewardDestinationName> = {
  staked: 'Staked',
  stash: 'Stash',
  controller: 'Controller',
  account: 'Account',
  none: 'None',
};

/**
 * Reads a decoded `RewardDestination` — from storage or from an event parameter — out of its
 * `.toJSON()` form.
 *
 * `.toJSON()` rather than the generated `Option<PalletStakingRewardDestination>` accessors,
 * deliberately: the generated types describe one metadata snapshot — the current one — while
 * both callers read blocks from runtimes that predate it, and `api` decodes against the block's
 * own registry. `.unwrap()` written against today's `OptionQuery` throws on a block where the
 * entry decodes as a bare `RewardDestination`. `.toJSON()` is the one accessor whose output is the same
 * either way: `null`, a bare string (`"Staked"` — when every variant of that runtime's type is a
 * unit variant), or a single-key object with the variant camel-cased (`{ staked: null }`,
 * `{ account: "0x…" }`).
 *
 * An unrecognised variant resolves to `None` — no destination account is claimed for it.
 */
export const readRewardDestination = (
  json: AnyJson
): { destination: RewardDestinationName; account?: string } => {
  let variant = '';
  let value: AnyJson = null;

  if (typeof json === 'string') {
    variant = json;
  } else if (json && typeof json === 'object' && !Array.isArray(json)) {
    [variant = ''] = Object.keys(json);
    value = json[variant] ?? null;
  }

  const destination = rewardDestinationByVariant[variant.toLowerCase()] ?? 'None';

  return destination === 'Account' && typeof value === 'string'
    ? { destination, account: value }
    : { destination };
};

/**
 * Per-block caches of the chain reads every staking path starts with: `staking.payee(stash)` and
 * `staking.bonded(stash)`, and `staking.ledger(controller)` behind them.
 *
 * **Block scoped, not process lifetime.** `set_payee` and `set_controller` emit no event, so
 * there is nothing a longer-lived entry could be invalidated on, and both went stale silently and
 * permanently: a changed payee kept crediting later rewards to the old destination, and a changed
 * controller made `staking.ledger(oldController)` read empty — which `readStakingLock` reports as
 * a bond of 0, clearing the stash's staking lock, and which `StakingPosition` reports as
 * `bonded: 0`. Worse, the answer depended on where the process happened to start, since each
 * worker and each restart began with an empty map.
 *
 * Keyed by block, the read repeats at most once per block per stash. That still collapses the
 * repeated reads within a payout block, which is where they cluster, and bounds staleness to
 * nothing: `api` targets the block being indexed, so an entry can only be read back within the
 * block it was true for.
 *
 * Only successful resolutions are cached — a transient read failure must be retried, not pinned.
 */
let cacheBlock: string | undefined;
let payeeCache = new Map<string, LegacyRewardDestination>();
let controllerCache = new Map<string, string>();
let ledgerCache = new Map<string, StakingLedgerSnapshot>();

const cachesFor = (
  blockId: string
): {
  payees: Map<string, LegacyRewardDestination>;
  controllers: Map<string, string>;
  ledgers: Map<string, StakingLedgerSnapshot>;
} => {
  if (cacheBlock !== blockId) {
    cacheBlock = blockId;
    payeeCache = new Map();
    controllerCache = new Map();
    ledgerCache = new Map();
  }

  return { payees: payeeCache, controllers: controllerCache, ledgers: ledgerCache };
};

/** Test hook — a suite re-mocking staking storage within one block must clear. */
export const __resetStakingCaches = (): void => {
  cacheBlock = undefined;
  payeeCache = new Map();
  controllerCache = new Map();
  ledgerCache = new Map();
};

/**
 * Resolves where a pre-v8 staking reward for `stash` was actually paid.
 *
 * The pre-8.x `Reward`/`Rewarded` event carries only the stash and the amount. A
 * staker who set a payee of `Controller` or an explicit `Account` received the POLYX somewhere
 * the event does not name. Measured across a spread of eras on mainnet, a large share of pre-v8
 * rewards went somewhere other than the stash, so the destination is read from
 * `staking.payee(stash)` — chain storage, at the block being indexed (`api.query` targets the
 * current block). Cheap during a genesis replay; needs an archive node afterwards, which is
 * why it is done now rather than deferred.
 */
export const resolveLegacyRewardDestination = async (
  stash: string,
  blockId: string
): Promise<LegacyRewardDestination> => {
  const payees = cachesFor(blockId).payees;
  const cached = payees.get(stash);
  if (cached) {
    return cached;
  }

  // Only a runtime without the storage falls back to the placeholder. A failed read fails the block,
  // so it is retried.
  if (typeof api.query.staking?.payee !== 'function') {
    return { rewardDestination: 'LegacyUnknown' };
  }

  const payee = await api.query.staking.payee(stash);
  const { destination, account } = readRewardDestination(payee.toJSON());

  let result: LegacyRewardDestination;

  if (destination === 'Staked' || destination === 'Stash') {
    result = {
      rewardDestination: destination,
      rewardDestinationAccount: stash,
    };
  } else if (destination === 'Controller') {
    const controller = (await api.query.staking.bonded(stash)).toJSON();

    result = {
      rewardDestination: 'Controller',
      rewardDestinationAccount: typeof controller === 'string' ? controller : undefined,
    };
  } else if (destination === 'Account') {
    result = {
      rewardDestination: 'Account',
      rewardDestinationAccount: account,
    };
  } else {
    result = { rewardDestination: 'None' };
  }

  payees.set(stash, result);

  return result;
};

/**
 * `staking.bonded(stash)` — the controller key `staking.ledger` is stored under.
 *
 * Exported so `StakingPosition.controller` (`mapStakingPosition.ts`) can reuse the same resolution
 * `readStakingLedger` already pays for, instead of a second `staking.bonded` read.
 *
 * Falls back to the stash — the common case, where stash and controller are the same account —
 * but **does not cache that fallback**: `bonded(stash)` is also empty for a stash that has not
 * bonded yet, and pinning `stash` as its answer would keep it wrong for the rest of the block
 *. Only a controller the chain actually named is cached.
 */
export const resolveController = async (stash: string, blockId: string): Promise<string> => {
  const controllers = cachesFor(blockId).controllers;
  const cached = controllers.get(stash);

  if (cached) {
    return cached;
  }

  const bonded = (await api.query.staking.bonded(stash)).toJSON();

  if (typeof bonded !== 'string') {
    return stash;
  }

  controllers.set(stash, bonded);

  return bonded;
};

export interface StakingLedgerSnapshot {
  /** `active` + everything still unlocking — what `Currency::set_lock`/the v8 hold amount matches */
  total: bigint;
  /** currently bonded, earning rewards — excludes chunks already in the unbonding queue */
  active: bigint;
  /** chunks queued by `unbond`, not yet withdrawable via `withdraw_unbonded` */
  unlocking: { amount: bigint; era: number }[];
}

/**
 * `staking.ledger(controller)`, read once and shared by every caller that needs a piece of it —
 * `readStakingLock` (the whole-lock `total`, for the balance ledger) and `StakingPosition`'s
 * `bonded`/`unbonding`/`unlocking` split (`active` vs the queued chunks) would otherwise each
 * issue the same chain read.
 *
 * A killed ledger (fully withdrawn) reads back as all-zero. A failed read fails the block.
 */
export const readStakingLedger = async (
  stash: string,
  blockId: string
): Promise<StakingLedgerSnapshot> => {
  // Per block, like the payee and controller above: a payout block restakes many rewards, and both
  // the ledger and `StakingPosition` read each stash's ledger.
  const ledgers = cachesFor(blockId).ledgers;
  const cached = ledgers.get(stash);
  if (cached) {
    return cached;
  }

  const snapshot = await readLedger(stash, blockId);
  ledgers.set(stash, snapshot);

  return snapshot;
};

const readLedger = async (stash: string, blockId: string): Promise<StakingLedgerSnapshot> => {
  const controller = await resolveController(stash, blockId);
  const ledger = (await api.query.staking.ledger(controller)).toJSON() as {
    total?: string | number;
    active?: string | number;
    unlocking?: { value?: string | number; era?: number }[];
  } | null;

  if (!ledger) {
    return { total: BigInt(0), active: BigInt(0), unlocking: [] };
  }

  return {
    total: BigInt(ledger.total ?? 0),
    active: BigInt(ledger.active ?? 0),
    unlocking: (ledger.unlocking ?? []).map(({ value, era }) => ({
      amount: BigInt(value ?? 0),
      era: Number(era ?? 0),
    })),
  };
};

/**
 * The pre-v8 staking lock on `stash`, read from chain: `staking.ledger(controller).total`
 * (bonded active + everything still unlocking), which is exactly the value `pallet-staking`
 * passes to `Currency::set_lock`, so it is what `miscFrozen` reports.
 *
 * Read rather than accumulated from `Bonded` / `Withdrawn` / restaked-`Reward` deltas: the deltas
 * do not see the max-bond cap, the rounding of a compounded `RewardDestination::Staked` reward,
 * or a slash — each of which leaves the accumulator drifting from the real lock.
 */
export const readStakingLock = async (stash: string, blockId: string): Promise<bigint> =>
  (await readStakingLedger(stash, blockId)).total;

/**
 * The era `StakersElected` just elected, read from `staking.currentEra()` — **not**
 * `staking.activeEra()`. Verified against `pallet-staking`'s `try_trigger_new_era`: the event is
 * deposited, then `trigger_new_era` increments `CurrentEra` and stores the new era's exposures —
 * both still within the same block. `ActiveEra` only catches up much later, when the session
 * pallet actually rotates onto that era (`start_session` → `start_era`, a separate, later block),
 * so reading `activeEra()` here would still return the *outgoing* era for a session or more.
 *
 * `undefined` when the chain has no current era yet.
 */
export const readCurrentEraIndex = async (): Promise<number | undefined> => {
  const currentEra = (await api.query.staking.currentEra()).toJSON() as number | null;

  return currentEra !== null && currentEra !== undefined ? Number(currentEra) : undefined;
};

/** `staking.activeEra().index`, the era being staked in at this block; `undefined` before the first. */
export const readActiveEraIndex = async (): Promise<number | undefined> => {
  const active = (await api.query.staking.activeEra()).toJSON() as { index?: number } | null;

  return active?.index ?? undefined;
};

/** One elected validator's exposure for an era. */
export interface EraExposure {
  stash: string;
  own: bigint;
  total: bigint;
  nominatorCount: number;
}

/**
 * The validators `StakersElected` just elected for `eraIndex` (from `readCurrentEraIndex` above),
 * with their exposure — **not** `session.validators()`, which still reports the outgoing set until
 * the session pallet rotates onto the new one, later.
 *
 * The election stores the exposures in the same block it fires. Before v8 the whole exposure goes
 * to `staking.erasStakers`; v8 stores a summary in `erasStakersOverview` and the nominators in
 * `erasStakersPaged`, and no longer writes `erasStakers`. The runtime that ran the election is the
 * one the block decodes with, so whichever map it has is the one it wrote.
 */
export const readEraExposures = async (eraIndex: number): Promise<EraExposure[]> => {
  const staking = api.query.staking;

  if (typeof staking.erasStakersOverview?.entries === 'function') {
    const entries = await staking.erasStakersOverview.entries(eraIndex);

    return entries.flatMap(([key, value]) => {
      if (value.isNone) {
        return [];
      }

      const overview = value.unwrap();

      return [
        {
          stash: key.args[1].toString(),
          own: BigInt(overview.own.toString()),
          total: BigInt(overview.total.toString()),
          nominatorCount: overview.nominatorCount.toNumber(),
        },
      ];
    });
  }

  const entries = await staking.erasStakers.entries(eraIndex);

  return entries.map(([key, exposure]) => ({
    stash: key.args[1].toString(),
    own: BigInt(exposure.own.toString()),
    total: BigInt(exposure.total.toString()),
    nominatorCount: exposure.others.length,
  }));
};

/** An elected validator's preferences for an era: commission in Perbill parts, and `blocked`. */
export interface EraValidatorPrefs {
  commission?: bigint;
  blocked?: boolean;
}

/**
 * Each elected validator's preferences for `eraIndex`, `staking.erasValidatorPrefs`, which the
 * election stores alongside the exposures. Runtimes before `blocked` existed leave it undefined.
 */
export const readEraValidatorPrefs = async (
  eraIndex: number
): Promise<Map<string, EraValidatorPrefs>> => {
  const entries = await api.query.staking.erasValidatorPrefs.entries(eraIndex);

  return new Map(
    entries.map(([key, prefs]) => {
      const json = prefs.toJSON() as { commission?: number; blocked?: boolean };

      return [
        key.args[1].toString(),
        {
          commission: json.commission !== undefined ? BigInt(json.commission) : undefined,
          blocked: json.blocked,
        },
      ];
    })
  );
};

/**
 * `staking.erasRewardPoints(eraIndex)`: the era's total points and each validator's. Points go to
 * the active era as blocks are authored, and the era ends and the next begins in the same session
 * rotation, so in the block that pays an era its points are final.
 */
export const readEraRewardPoints = async (
  eraIndex: number
): Promise<{ total: number; individual: Map<string, number> }> => {
  const points = await api.query.staking.erasRewardPoints(eraIndex);

  return {
    total: points.total.toNumber(),
    individual: new Map(
      [...points.individual.entries()].map(([stash, earned]) => [
        stash.toString(),
        earned.toNumber(),
      ])
    ),
  };
};

/**
 * Whether `identityId` is a permissioned validator identity at the block being indexed.
 *
 * The storage moved pallets at v8: `staking.permissionedIdentity` before, `validators.permissionedIdentity`
 * from v8 on. `api` decodes against the block's own runtime, so whichever pallet that runtime has is
 * the one present — both are tried rather than gating on a spec version. The value is
 * `Option<PermissionedIdentityPrefs>`: any `Some` means permissioned.
 *
 * `undefined` when neither pallet has the storage, which the caller treats as "not known to be
 * permissioned" rather than guessing.
 */
export const readPermissionedIdentity = async (
  identityId: string
): Promise<boolean | undefined> => {
  const query = api.query as unknown as Record<
    string,
    { permissionedIdentity?: (id: string) => Promise<{ toJSON: () => unknown }> } | undefined
  >;

  for (const pallet of ['validators', 'staking']) {
    const read = query[pallet]?.permissionedIdentity;

    if (read) {
      const prefs = (await read(identityId)).toJSON();

      return prefs !== null && prefs !== undefined;
    }
  }

  return undefined;
};

/** Total POLYX staked across all validators for `eraIndex` — `staking.erasTotalStake(eraIndex)`. */
export const readEraTotalStake = async (eraIndex: number): Promise<bigint> =>
  // `.toString()` rather than `getBigIntValue`/`.toJSON()`: a bare top-level `u128` codec here,
  // not the decoded-struct/event-param `Codec` those take — the value is the same, but plumbing
  // it through `getBigIntValue`'s `Codec` param trips a `@polkadot/types-codec` duplicate-package
  // type mismatch under the webpack build that `tsc`/jest don't surface.
  BigInt((await api.query.staking.erasTotalStake(eraIndex)).toString());
