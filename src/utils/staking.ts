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
 * Per-stash cache of a resolved payee. `staking.payee(stash)` is a chain-storage read on every
 * reward, and a validator's set of ~20 stashes is re-queried every era for the whole genesis
 * replay — the dominant RPC cost of the sweep against a remote node. A payee changes very rarely
 * (an explicit `staking.setPayee`), and the in-flight reconciler corrects any `frozen` drift a
 * stale entry could cause within ~1 era, so a plain process-lifetime cache is the right trade.
 * Only successful resolutions are cached — a transient read failure must be retried, not pinned.
 */
const payeeCache = new Map<string, LegacyRewardDestination>();

/** Test hook — the cache is process-lifetime, so a suite that re-mocks `staking.payee` must clear it. */
export const __resetPayeeCache = (): void => payeeCache.clear();

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
  stash: string
): Promise<LegacyRewardDestination> => {
  const cached = payeeCache.get(stash);
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

    payeeCache.set(stash, result);

    return result;
  } catch {
    // A pruned node, or a runtime with no `staking.payee` storage — fall back to the placeholder.
    return { rewardDestination: 'LegacyUnknown' };
  }
};
