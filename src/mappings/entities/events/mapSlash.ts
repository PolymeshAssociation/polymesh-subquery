import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { AnomalyKind, Slash } from '../../../types';
import { blockTime } from '../../../utils';
import { ledgerAccount } from '../../../utils/accounts';
import { recordAnomaly } from '../../../utils/anomaly';
import { appliedDeferredSlash, deferredSlashesBefore } from '../../../utils/deferredSlashes';
import { extractArgs } from '../common';
import { amountOf, stakingStash } from '../identities/ledgerCore';

/**
 * `staking.Slash` (before v8) / `staking.Slashed` (v8): one stash's stake slashed.
 *
 * The event names only the stash and the amount. Polymesh defers every slash (mainnet and testnet
 * by 14 eras), and applying one takes it out of `staking.unappliedSlashes`, so the slash it came
 * from is in the state the block started from: that gives the offending validator, whose own slash
 * is `own` and whose nominators' are `others`, and the era it was applied in.
 */
export const handleSlash = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockId, blockEventId, eventIdx, moduleId, eventId } = extractArgs(event);
  const decoded = decodeEvent(event);
  const stash = stakingStash(decoded);
  const amount = amountOf(decoded);

  if (!stash) {
    return;
  }

  const [account, deferred] = await Promise.all([
    ledgerAccount(stash, blockId, blockTime(block), blockEventId),
    deferredSlashesBefore(block),
  ]);
  const applied = deferred ? appliedDeferredSlash(deferred, stash, amount) : undefined;

  if (!applied) {
    await recordAnomaly({
      kind: AnomalyKind.UnreadableValue,
      detail: `staking.${eventId} of ${amount} on ${stash} matches no deferred slash${
        deferred ? '' : ' (the deferred slashes could not be read)'
      }, so its validator and era are unknown`,
      block,
      eventIdx,
      moduleId,
      eventId,
    });
  }

  await Slash.create({
    id: blockEventId,
    accountId: account.id,
    validatorId: applied?.slash.validator,
    eraIndex: applied?.slash.era,
    amount,
    createdEventId: blockEventId,
  }).save();
};
