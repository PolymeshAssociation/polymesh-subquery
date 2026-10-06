import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { getBigIntValue, getTextValue } from './common';
import { storageEntriesAtParent, UndecodableStateError } from './storageAtParent';

/** One `staking.UnappliedSlash`: a slash the chain holds back until its era comes due. */
export interface DeferredSlash {
  /** the era the slash is applied in */
  era: number;
  validator: string;
  own: bigint;
  /** each nominator's share: `[stash, amount]` */
  others: [string, bigint][];
  reporters: string[];
  payout: bigint;
}

const readDeferredSlashes = async (block: SubstrateBlock): Promise<DeferredSlash[] | undefined> => {
  const entries = await storageEntriesAtParent(block, 'staking', 'unappliedSlashes').catch(
    (error: unknown) => {
      if (error instanceof UndecodableStateError) {
        return undefined;
      }
      throw error;
    }
  );

  // a key whose era didn't decode leaves its slashes unplaceable, which is not "none deferred"
  if (entries?.some(({ args }) => args.length === 0)) {
    return undefined;
  }

  return entries?.flatMap(({ args: [era], value }) => {
    const deferred = value as unknown as {
      validator: Codec;
      own: Codec;
      others: [Codec, Codec][];
      reporters: Codec[];
      payout: Codec;
    }[];

    return deferred.map(slash => ({
      era: Number(getBigIntValue(era)),
      validator: getTextValue(slash.validator),
      own: getBigIntValue(slash.own),
      others: slash.others.map(([stash, amount]): [string, bigint] => [
        getTextValue(stash),
        getBigIntValue(amount),
      ]),
      reporters: slash.reporters.map(reporter => getTextValue(reporter)),
      payout: getBigIntValue(slash.payout),
    }));
  });
};

const deferredByBlock = new WeakMap<SubstrateBlock, Promise<DeferredSlash[] | undefined>>();

/**
 * The slashes still deferred as `block` begins, which is the set it applies from; `undefined` when
 * that state can't be read (see `storageEntriesAtParent`).
 *
 * Read at the parent hash, because applying a slash takes it out of storage, so the block's own
 * state no longer holds it. Read once per block: every slash the block applies is placed from the
 * same set.
 */
export const deferredSlashesBefore = (
  block: SubstrateBlock
): Promise<DeferredSlash[] | undefined> => {
  let deferred = deferredByBlock.get(block);

  if (!deferred) {
    deferred = readDeferredSlashes(block);
    deferredByBlock.set(block, deferred);
  }

  return deferred;
};

/**
 * The deferred slash a `Slash` of `amount` on `stash` was applied from, and whether `stash` was its
 * validator rather than a nominator. Eras are applied in order, so of several that match, the oldest
 * is the one applied.
 */
export const appliedDeferredSlash = (
  deferred: DeferredSlash[],
  stash: string,
  amount: bigint
): { slash: DeferredSlash; asValidator: boolean } | undefined => {
  const oldest = (matches: DeferredSlash[]): DeferredSlash | undefined =>
    [...matches].sort((a, b) => a.era - b.era)[0];

  const own = oldest(deferred.filter(slash => slash.validator === stash && slash.own === amount));

  if (own) {
    return { slash: own, asValidator: true };
  }

  const share = oldest(
    deferred.filter(slash =>
      slash.others.some(([nominator, value]) => nominator === stash && value === amount)
    )
  );

  return share ? { slash: share, asValidator: false } : undefined;
};
