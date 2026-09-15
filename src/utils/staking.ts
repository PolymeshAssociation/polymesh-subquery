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
 * entry decodes as a bare `RewardDestination`, and that throw lands in a `catch` that would turn
 * every reward into `LegacyUnknown`. `.toJSON()` is the one accessor whose output is the same
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
 * Per-block caches of the two chain reads every staking path starts with: `staking.payee(stash)`
 * and `staking.bonded(stash)`.
 *
 * **Block scoped, not process lifetime (F6).** `set_payee` and `set_controller` emit no event, so
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

const cachesFor = (
  blockId: string
): { payees: Map<string, LegacyRewardDestination>; controllers: Map<string, string> } => {
  if (cacheBlock !== blockId) {
    cacheBlock = blockId;
    payeeCache = new Map();
    controllerCache = new Map();
  }

  return { payees: payeeCache, controllers: controllerCache };
};

/** Test hook — a suite re-mocking `staking.payee` / `staking.bonded` within one block must clear. */
export const __resetStakingCaches = (): void => {
  cacheBlock = undefined;
  payeeCache = new Map();
  controllerCache = new Map();
};

/**
 * Resolves where a pre-v8 staking reward for `stash` was actually paid.
 *
 * Defect A15: the pre-8.x `Reward`/`Rewarded` event carries only the stash and the amount. A
 * staker who set a payee of `Controller` or an explicit `Account` received the POLYX somewhere
 * the event does not name. Measured across a spread of eras on mainnet, a large share of pre-v8
 * rewards went somewhere other than the stash, so the destination is read from
 * `staking.payee(stash)` — chain storage, at the block being indexed (`api.query` targets the
 * current block). Cheap during the D5 genesis replay; needs an archive node afterwards, which is
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

  try {
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
  } catch {
    // A pruned node, or a runtime with no `staking.payee` storage — fall back to the placeholder.
    return { rewardDestination: 'LegacyUnknown' };
  }
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
 * (F6). Only a controller the chain actually named is cached.
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
 * `undefined` when the ledger cannot be read (a runtime with a different shape, a pruned node) —
 * callers keep their delta accumulator as the fallback. A killed ledger (fully withdrawn) reads
 * back as all-zero, not `undefined`.
 */
export const readStakingLedger = async (
  stash: string,
  blockId: string
): Promise<StakingLedgerSnapshot | undefined> => {
  try {
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
  } catch {
    return undefined;
  }
};

/**
 * The pre-v8 staking lock on `stash`, read from chain: `staking.ledger(controller).total`
 * (bonded active + everything still unlocking), which is exactly the value `pallet-staking`
 * passes to `Currency::set_lock`, so it is what `miscFrozen` reports.
 *
 * Read rather than accumulated from `Bonded` / `Withdrawn` / restaked-`Reward` deltas: the deltas
 * do not see the max-bond cap, the rounding of a compounded `RewardDestination::Staked` reward,
 * or a slash — each of which leaves the accumulator drifting from the real lock.
 *
 * `undefined` when the ledger cannot be read — the caller keeps its delta accumulator as the
 * fallback.
 */
export const readStakingLock = async (
  stash: string,
  blockId: string
): Promise<bigint | undefined> => (await readStakingLedger(stash, blockId))?.total;

/**
 * The era `StakersElected` just elected, read from `staking.currentEra()` — **not**
 * `staking.activeEra()`. Verified against `pallet-staking`'s `try_trigger_new_era`: the event is
 * deposited, then `trigger_new_era` increments `CurrentEra` and stores the new era's exposures —
 * both still within the same block. `ActiveEra` only catches up much later, when the session
 * pallet actually rotates onto that era (`start_session` → `start_era`, a separate, later block),
 * so reading `activeEra()` here would still return the *outgoing* era for a session or more.
 *
 * `undefined` when the read fails (a pruned node, or a runtime with no current era yet) — the
 * caller leaves the era unset rather than guessing.
 */
export const readCurrentEraIndex = async (): Promise<number | undefined> => {
  try {
    const currentEra = (await api.query.staking.currentEra()).toJSON() as number | null;

    return currentEra !== null && currentEra !== undefined ? Number(currentEra) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The validator set `StakersElected` just elected, for `eraIndex` (from `readCurrentEraIndex`
 * above) — read from `staking.erasStakers(eraIndex)` keys, **not** `session.validators()`.
 * `trigger_new_era` populates `ErasStakers` (via `store_stakers_info`) for the new era in the same
 * block `StakersElected` fires; `session.validators()` still reports the *outgoing*,
 * currently-serving set at that point — the new set only takes over once the session pallet
 * rotates onto it, later. Enumerating the double-map's keys for a fixed era index is the standard
 * way to list its validators without reading each `Exposure` value.
 */
export const readEraValidators = async (eraIndex: number): Promise<string[] | undefined> => {
  try {
    const keys = await api.query.staking.erasStakers.keys(eraIndex);

    return keys.map(key => key.args[1].toString());
  } catch {
    return undefined;
  }
};

/** Total POLYX staked across all validators for `eraIndex` — `staking.erasTotalStake(eraIndex)`. */
export const readEraTotalStake = async (eraIndex: number): Promise<bigint | undefined> => {
  try {
    // `.toString()` rather than `getBigIntValue`/`.toJSON()`: a bare top-level `u128` codec here,
    // not the decoded-struct/event-param `Codec` those take — the value is the same, but plumbing
    // it through `getBigIntValue`'s `Codec` param trips a `@polkadot/types-codec` duplicate-package
    // type mismatch under the webpack build that `tsc`/jest don't surface.
    return BigInt((await api.query.staking.erasTotalStake(eraIndex)).toString());
  } catch {
    return undefined;
  }
};
