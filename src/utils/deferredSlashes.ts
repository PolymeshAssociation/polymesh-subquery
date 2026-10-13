import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { getBigIntValue, getTextValue } from './common';
import { storageEntriesAtParent, UndecodableStateError } from './storageAtParent';

/** One `staking.UnappliedSlash`: a slash the chain holds back until its era comes due. */
export interface DeferredSlash {
  /**
   * The era it is held under. From v7.0 that is the era it is applied in, `slash_era + defer + 1`;
   * before v7.0 it is the era it was reported in, applied once the active era passes it by more
   * than the defer duration.
   */
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
 * The stashes slashed before event `eventIdx` in `block`, nearest first: `staking.Slash` before v7,
 * `staking.Slashed` from v7, each naming the stash first.
 */
export const slashedBefore = (block: SubstrateBlock, eventIdx: number): string[] =>
  (block.events ?? [])
    .slice(0, eventIdx)
    .filter(
      ({ event }) =>
        event.section === 'staking' && (event.method === 'Slash' || event.method === 'Slashed')
    )
    .map(({ event }) => event.data[0].toString())
    .reverse();

/**
 * The deferred slash a `Slash` of `amount` on `stash` was applied from, and whether `stash` was its
 * validator rather than a nominator. The deferred figure is an upper bound, not the amount: the
 * runtime slashes no more than the stash's ledger holds and the event reports what was taken, so a
 * match is a figure at least `amount`, an exact one preferred.
 *
 * A block applies the slashes of one era, the oldest still deferred (the runtime takes them once,
 * as the era starts), so only that era is matched. A newer era's figure that happens to fit, such
 * as a validator's own slash seen from the same stash acting as a nominator, is not this slash.
 *
 * A nominator's share can match the slashes of two validators it nominated. Applying a slash takes
 * the validator's own share first and then its nominators', so the nominator's is the one whose
 * validator was slashed most recently before it (`earlier`, nearest first).
 */
export const appliedDeferredSlash = (
  deferred: DeferredSlash[],
  stash: string,
  amount: bigint,
  earlier: string[] = []
): { slash: DeferredSlash; asValidator: boolean } | undefined => {
  const era = Math.min(...deferred.map(slash => slash.era));
  const applying = deferred.filter(slash => slash.era === era);

  const exactOrAll = (
    matches: DeferredSlash[],
    exact: (slash: DeferredSlash) => boolean
  ): DeferredSlash[] => {
    const exacts = matches.filter(exact);
    return exacts.length > 0 ? exacts : matches;
  };

  const owned = applying.filter(slash => slash.validator === stash && slash.own >= amount);
  const own = exactOrAll(owned, slash => slash.own === amount)[0];

  if (own) {
    return { slash: own, asValidator: true };
  }

  const holds = (slash: DeferredSlash, test: (value: bigint) => boolean): boolean =>
    slash.others.some(([nominator, value]) => nominator === stash && test(value));
  const shares = exactOrAll(
    applying.filter(slash => holds(slash, value => value >= amount)),
    slash => holds(slash, value => value === amount)
  );
  const nearest = earlier.find(validator => shares.some(slash => slash.validator === validator));
  const share = (
    nearest === undefined ? shares : shares.filter(slash => slash.validator === nearest)
  )[0];

  return share ? { slash: share, asValidator: false } : undefined;
};
