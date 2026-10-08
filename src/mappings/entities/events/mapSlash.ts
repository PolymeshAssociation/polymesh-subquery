import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { AnomalyKind, Slash } from '../../../types';
import { blockTime } from '../../../utils';
import { ledgerAccount } from '../../../utils/accounts';
import { recordAnomaly } from '../../../utils/anomaly';
import {
  appliedDeferredSlash,
  deferredSlashesBefore,
  slashedBefore,
} from '../../../utils/deferredSlashes';
import { readActiveEraIndex } from '../../../utils/staking';
import { extractArgs } from '../common';
import { amountOf, stakingStash } from '../identities/ledgerCore';

/**
 * The first runtime that holds a deferred slash under the era it is applied in, rather than the era
 * it was reported in (`on_offence` from v7.0).
 */
const APPLY_ERA_KEYS_FROM = 7_000_000;

/**
 * `staking.Slash` (before v8) / `staking.Slashed` (v8): one stash's stake slashed.
 *
 * The event names only the stash and the amount. Polymesh defers every slash (mainnet and testnet
 * by 14 eras), and applying one takes it out of `staking.unappliedSlashes`, so the slash it came
 * from is in the state the block started from: that gives the offending validator, whose own slash
 * is `own` and whose nominators' are `others`.
 *
 * `eraIndex` is the active era, which is the era the slash is applied in on every runtime. The
 * offence era is the deferred slash's key less the defer duration and one, but only from v7.0:
 * earlier runtimes key it by the era it was reported in and keep no offence era.
 */
export const handleSlash = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockId, blockEventId, eventIdx, moduleId, eventId } = extractArgs(event);
  const decoded = decodeEvent(event);
  const stash = stakingStash(decoded);
  const amount = amountOf(decoded);

  if (!stash) {
    return;
  }

  const [account, deferred, activeEra] = await Promise.all([
    ledgerAccount(stash, blockId, blockTime(block), blockEventId),
    deferredSlashesBefore(block),
    readActiveEraIndex(),
  ]);
  const applied = deferred
    ? appliedDeferredSlash(deferred, stash, amount, slashedBefore(block, eventIdx))
    : undefined;

  if (!applied) {
    await recordAnomaly({
      kind: AnomalyKind.UnreadableValue,
      detail: `staking.${eventId} of ${amount} on ${stash} matches no deferred slash${
        deferred ? '' : ' (the deferred slashes could not be read)'
      }, so its validator and offence era are unknown`,
      block,
      eventIdx,
      moduleId,
      eventId,
    });
  }

  const offenceEraIndex =
    applied && block.specVersion >= APPLY_ERA_KEYS_FROM
      ? applied.slash.era - api.consts.staking.slashDeferDuration.toNumber() - 1
      : undefined;

  await Slash.create({
    id: blockEventId,
    accountId: account.id,
    validatorId: applied?.slash.validator,
    eraIndex: activeEra,
    offenceEraIndex,
    amount,
    createdEventId: blockEventId,
  }).save();
};
