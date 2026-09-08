export interface LegacyRewardDestination {
  /** `Staked` | `Stash` | `Controller` | `Account` | `None` | `LegacyUnknown` (read failed) */
  rewardDestination: string;
  /** The account the reward was actually paid to, where it can be resolved */
  rewardDestinationAccount?: string;
}

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
  try {
    const payee = await api.query.staking.payee(stash);
    const json = payee.toJSON() as string | Record<string, unknown> | null;

    if (json === 'Staked' || json === 'Stash') {
      return { rewardDestination: json, rewardDestinationAccount: stash };
    }

    if (json === 'Controller') {
      const controller = (await api.query.staking.bonded(stash)).toJSON() as string | null;

      return {
        rewardDestination: 'Controller',
        rewardDestinationAccount: controller ?? undefined,
      };
    }

    if (json && typeof json === 'object') {
      const account = (json.account ?? json.Account) as string | undefined;

      return { rewardDestination: 'Account', rewardDestinationAccount: account };
    }

    return { rewardDestination: typeof json === 'string' ? json : 'None' };
  } catch {
    // A pruned node, or a runtime with no `staking.payee` storage — fall back to the placeholder.
    return { rewardDestination: 'LegacyUnknown' };
  }
};
