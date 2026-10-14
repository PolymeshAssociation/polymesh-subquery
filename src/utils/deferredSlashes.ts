import { SubstrateBlock } from '@subql/types';
import { EventIdEnum, ModuleIdEnum } from '../types';
import { readOrAnomaly } from './anomaly';
import { itemsOf, memberOf } from './codec';
import { getBigIntValue, getTextValue } from './common';
import { readActiveEraIndex } from './staking';
import { storageEntriesAtParent, UndecodableStateError } from './storageAtParent';

/**
 * The first runtime that holds a deferred slash under the era it is applied in, rather than the era
 * it was reported in (`on_offence` from v7.0).
 */
export const APPLY_ERA_KEYS_FROM = 7_000_000;

/**
 * The era whose deferred slashes `block` applies, given the active era: from v7.0 that is the active
 * era itself, since the runtime takes exactly that key as the era starts. Earlier runtimes apply
 * every key up to a threshold, so there is none (`undefined`) and the oldest era present is used.
 */
export const dueEraAt = (
  block: SubstrateBlock,
  activeEra: number | undefined
): number | undefined => (block.specVersion >= APPLY_ERA_KEYS_FROM ? activeEra : undefined);

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
    return itemsOf(value, 'the deferred slashes').map(slash => ({
      era: Number(getBigIntValue(era)),
      validator: getTextValue(memberOf(slash, 'validator')),
      own: getBigIntValue(memberOf(slash, 'own')),
      others: itemsOf(memberOf(slash, 'others'), 'the slash others').map(
        (other): [string, bigint] => {
          const [stash, amount] = itemsOf(other, 'a slash other');

          return [getTextValue(stash), getBigIntValue(amount)];
        }
      ),
      reporters: itemsOf(memberOf(slash, 'reporters'), 'the slash reporters').map(reporter =>
        getTextValue(reporter)
      ),
      payout: getBigIntValue(memberOf(slash, 'payout')),
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

const activeEraByBlock = new WeakMap<SubstrateBlock, Promise<number | undefined>>();

/**
 * The active era as `block` is indexed, which is the era its slashes are applied in; `undefined`
 * when it can't be decoded, recorded as an anomaly. Read once per block, however many slashes it
 * holds and however many handlers place them, so an undecodable era is recorded once, not for each.
 */
export const activeEraAt = (
  block: SubstrateBlock,
  context: { eventIdx?: number; moduleId?: ModuleIdEnum; eventId?: EventIdEnum }
): Promise<number | undefined> => {
  let era = activeEraByBlock.get(block);

  if (!era) {
    era = readOrAnomaly(
      { block, ...context },
      `the era of this block's slashes is unknown, and from v7.0 they are not placed`,
      readActiveEraIndex
    );
    activeEraByBlock.set(block, era);
  }

  return era;
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
 * A block applies the slashes of one era (the runtime takes them once, as the era starts), so only
 * that era is matched: `dueEra` when given (from v7.0, see `dueEraAt`), else the oldest still
 * deferred. From v7.0 a key that is already past, such as a late-reported offence's, is never
 * applied and stays in storage, which is why the era is named there. Before v7.0 slashes are keyed
 * by the era they were reported in and every key up to the active era less the defer duration is
 * drained, so none is left behind and the oldest present is the one applied. A newer era's figure
 * that happens to fit, such as a validator's own slash seen from the same stash acting as a
 * nominator, is not this slash.
 *
 * A nominator's share can match the slashes of two validators it nominated. Applying a slash takes
 * the validator's own share first and then its nominators', so the nominator's is the one whose
 * validator was slashed most recently before it (`earlier`, nearest first). A validator whose own
 * share is nothing, or is capped to nothing, is not announced at all (`do_slash` emits only for a
 * non-zero amount), so its nominators have no such validator before them: then the share is placed
 * by the nominator alone, when that leaves a single deferred slash (the exact figures, if any,
 * otherwise those it could be capped from), and is left unplaced when it leaves several.
 */
export const appliedDeferredSlash = (
  deferred: DeferredSlash[],
  stash: string,
  amount: bigint,
  earlier: string[] = [],
  dueEra?: number
): { slash: DeferredSlash; asValidator: boolean } | undefined => {
  const era = dueEra ?? Math.min(...deferred.map(slash => slash.era));
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
  // with no validator before it to follow, a share alone places it only when it is the one fit
  const alone = shares.length === 1 ? shares[0] : undefined;
  const share = nearest === undefined ? alone : shares.find(slash => slash.validator === nearest);

  return share ? { slash: share, asValidator: false } : undefined;
};

interface Placements {
  deferred: DeferredSlash[];
  dueEra: number | undefined;
  /** what each `Slash` in the block was placed as, by event index */
  placed: Map<number, ReturnType<typeof appliedDeferredSlash>>;
  /** the index of the first `Slash` each deferred slash was applied from */
  first: Map<DeferredSlash, number>;
}

const placementsByBlock = new WeakMap<SubstrateBlock, Placements>();

const isSlashRecord = ({ event }: { event: { section: string; method: string } }): boolean =>
  event.section === 'staking' && (event.method === 'Slash' || event.method === 'Slashed');

/**
 * Places every `Slash` in `block` in one pass, in order, each against the stashes slashed before
 * it. Done once per block and kept, whatever the number of slashes it applies: a block that starts
 * an era can apply hundreds, and placing each from scratch would replay all those before it.
 */
const placementsOf = (
  deferred: DeferredSlash[],
  block: SubstrateBlock,
  dueEra: number | undefined
): Placements => {
  const known = placementsByBlock.get(block);

  if (known?.deferred === deferred && known.dueEra === dueEra) {
    return known;
  }

  const placements: Placements = { deferred, dueEra, placed: new Map(), first: new Map() };
  // nearest first, as `appliedDeferredSlash` takes it
  const earlier: string[] = [];

  (block.events ?? []).forEach((record, idx) => {
    if (!isSlashRecord(record)) {
      return;
    }

    const stash = record.event.data[0].toString();
    const placed = appliedDeferredSlash(
      deferred,
      stash,
      BigInt(record.event.data[1].toString()),
      earlier,
      dueEra
    );

    placements.placed.set(idx, placed);
    if (placed && !placements.first.has(placed.slash)) {
      placements.first.set(placed.slash, idx);
    }
    earlier.unshift(stash);
  });

  placementsByBlock.set(block, placements);

  return placements;
};

/**
 * The deferred slash the `Slash` at `eventIdx` was applied from (see `appliedDeferredSlash`), with
 * the stashes slashed before it taken from the block. From v7.0 a slash is only placed against the
 * active era; without it (`dueEra` undefined, which `activeEraAt` records) it is left unplaced
 * rather than put to the oldest era, which from v7.0 can be a stale one.
 */
export const placeSlash = (
  deferred: DeferredSlash[],
  block: SubstrateBlock,
  eventIdx: number,
  stash: string,
  amount: bigint,
  dueEra?: number
): ReturnType<typeof appliedDeferredSlash> => {
  if (dueEra === undefined && block.specVersion >= APPLY_ERA_KEYS_FROM) {
    return undefined;
  }

  const { placed } = placementsOf(deferred, block, dueEra);

  return placed.has(eventIdx)
    ? placed.get(eventIdx)
    : appliedDeferredSlash(deferred, stash, amount, slashedBefore(block, eventIdx), dueEra);
};

/**
 * Whether the `Slash` at `eventIdx` is the first one in `block` that `slash` was applied from. That
 * is its validator's own, unless the validator's share was nothing and so announced nothing, when
 * it is the first nominator's. Done once per deferred slash, whatever announced it first.
 */
export const isFirstSlashOf = (
  deferred: DeferredSlash[],
  slash: DeferredSlash,
  block: SubstrateBlock,
  eventIdx: number,
  dueEra?: number
): boolean => {
  const first = placementsOf(deferred, block, dueEra).first.get(slash);

  return first === undefined || first >= eventIdx;
};
