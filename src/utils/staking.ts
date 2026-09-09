export interface LegacyRewardDestination {
  /** `Staked` | `Stash` | `Controller` | `Account` | `None` | `LegacyUnknown` (read failed) */
  rewardDestination: string;
  /** The account the reward was actually paid to, where it can be resolved */
  rewardDestinationAccount?: string;
}

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
    const json = payee.toJSON() as string | Record<string, unknown> | null;

    // `RewardDestination` renders either as a bare string (`"Staked"`) or, via `.toJSON()`, as a
    // single-key object with the variant name lower-cased (`{ staked: null }`, `{ account: "0x…" }`).
    const variant = (
      typeof json === 'string' ? json : Object.keys(json ?? {})[0] ?? ''
    ).toLowerCase();
    const value =
      json && typeof json === 'object' ? (json as Record<string, unknown>)[variant] : undefined;

    let result: LegacyRewardDestination;

    if (variant === 'staked' || variant === 'stash') {
      result = {
        rewardDestination: variant === 'staked' ? 'Staked' : 'Stash',
        rewardDestinationAccount: stash,
      };
    } else if (variant === 'controller') {
      const controller = (await api.query.staking.bonded(stash)).toJSON() as string | null;

      result = {
        rewardDestination: 'Controller',
        rewardDestinationAccount: controller ?? undefined,
      };
    } else if (variant === 'account') {
      result = {
        rewardDestination: 'Account',
        rewardDestinationAccount: typeof value === 'string' ? value : undefined,
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
