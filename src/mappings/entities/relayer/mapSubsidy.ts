import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { EventIdEnum, Subsidy } from '../../../types';
import {
  blockTime,
  findStorage,
  getBigIntValue,
  getOrCreateAccount,
  getTextValue,
  is8xChain,
} from '../../../utils';
import { readOrAnomaly } from '../../../utils/anomaly';
import { readStorage } from '../../../utils/storageAtParent';
import { extractArgs, getOrAnomaly } from '../common';

/**
 * `relayer` pallet handlers.
 *
 * Renamed paying-key → subsidy at chain v8.0.0 (docs/reference/event-shape-verification.md is
 * silent on this domain — verified directly against `pallets/relayer/src/lib.rs`). Each handler
 * below is registered for both the pre-v8 and v8+ event names, since the field names in
 * `src/decode/shapes/relayer.ts` were chosen so one handler reads either era.
 */
const subsidyId = (userKey: string, payingKey: string): string => `${userKey}/${payingKey}`;

const ensureAccounts = async (
  userKey: string,
  payingKey: string,
  blockId: string,
  datetime: Date,
  blockEventId: string
): Promise<void> => {
  await Promise.all([
    getOrCreateAccount(userKey, blockId, datetime, blockEventId),
    getOrCreateAccount(payingKey, blockId, datetime, blockEventId),
  ]);
};

/**
 * An offer of a subsidy. It changes nothing until it is accepted.
 *
 * The same paying key can offer again while its earlier subsidy is still live, and the chain goes on
 * paying from that subsidy until the new offer is accepted. The row is keyed on the pair, so it
 * cannot hold both. It keeps the live subsidy, and the acceptance takes up the new one. Overwriting
 * it here marked a live subsidy as merely offered, and every fee the paying key covered in between
 * was charged to the user instead.
 */
export const handleSubsidyApproved = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockId, blockEventId } = extractArgs(event);
  const {
    userKey: rawUserKey,
    payingKey: rawPayingKey,
    initialPolyxLimit: rawLimit,
  } = decodeEvent(event);

  const userKey = getTextValue(rawUserKey);
  const payingKey = getTextValue(rawPayingKey);
  const existing = await Subsidy.get(subsidyId(userKey, payingKey));

  if (existing?.isAccepted && !existing.isRemoved) {
    return;
  }

  await ensureAccounts(userKey, payingKey, blockId, blockTime(block), blockEventId);

  await Subsidy.create({
    id: subsidyId(userKey, payingKey),
    beneficiaryAccountId: userKey,
    payingAccountId: payingKey,
    allowance: getBigIntValue(rawLimit),
    // Only countable from v8, which is when the chain started emitting `SubsidyDebited`. Left null
    // across the earlier range so "nothing was drawn" and "not knowable" stay different answers.
    totalDebited: is8xChain(block) ? BigInt(0) : undefined,
    isAccepted: false,
    isRemoved: false,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();
};

/**
 * Loads the `Subsidy` a mutating event refers to, recording a `MissingReferencedEntity` anomaly
 * instead of silently doing nothing when the approval that would have created it was not indexed.
 *
 * Used by the events that can only follow an acceptance — which now always leaves a row (see
 * `handleSubsidyAccepted`), so reaching the anomaly here means something genuinely unexplained.
 */
const getSubsidyOrAnomaly = (
  userKey: string,
  payingKey: string,
  event: SubstrateEvent
): Promise<Subsidy | undefined> =>
  getOrAnomaly(id => Subsidy.get(id), subsidyId(userKey, payingKey), 'Subsidy', event);

/**
 * What is left of `userKey`'s subsidy from `payingKey`, as the chain holds it at the end of the
 * block.
 *
 * `relayer.subsidies(userKey)` is `Option<{ payingKey, remaining }>`. `undefined` when the user has
 * no subsidy from `payingKey` by then, and also, with an anomaly, when the entry doesn't decode with
 * the block's metadata.
 */
const readChainAllowance = (
  userKey: string,
  payingKey: string,
  block: SubstrateBlock,
  eventIdx: number
): Promise<bigint | undefined> =>
  readOrAnomaly(
    { block, eventIdx },
    `the allowance of ${userKey} was not read from the chain`,
    async () => {
      const raw = await readStorage(
        `relayer.subsidies of ${userKey}`,
        async () =>
          (await api.query.relayer.subsidies(userKey)).toJSON() as {
            payingKey?: string;
            remaining?: string | number;
          } | null
      );

      return raw?.remaining === undefined || raw.payingKey !== payingKey
        ? undefined
        : BigInt(raw.remaining);
    }
  );

/** The paying-key authorization: `AddRelayerPayingKey` before 8.0, `OldAddRelayerPayingKey` from it */
const PAYING_KEY_OFFERS = new Set(['addrelayerpayingkey', 'oldaddrelayerpayingkey']);

/** A field by name, whatever casing the runtime's metadata gave it */
const field = (record: Record<string, unknown> | null | undefined, name: string): unknown =>
  Object.entries(record ?? {}).find(([key]) => key.replace(/_/g, '').toLowerCase() === name)?.[1];

/**
 * The limit of an offer from `payingKey` that `userKey` can still accept, at the end of the block.
 *
 * From 8.0 an offer is a `relayer.pendingSubsidies(user, payer)` entry, which a new offer replaces.
 * Before 8.0 each offer is a paying-key authorization of its own, so several can be pending at once,
 * and the latest is taken. A paying-key authorization made before 8.0 can still be pending after it.
 */
const readPendingOffer = (
  userKey: string,
  payingKey: string,
  block: SubstrateBlock,
  eventIdx: number
): Promise<bigint | undefined> =>
  readOrAnomaly(
    { block, eventIdx },
    `the offers pending for ${userKey} were not read from the chain`,
    async () => {
      const pendingSubsidies = findStorage('relayer', 'pendingSubsidies');

      if (pendingSubsidies) {
        const pending = await readStorage(
          `relayer.pendingSubsidies of ${userKey}`,
          async () =>
            (await pendingSubsidies(userKey, payingKey)).toJSON() as string | number | null
        );

        if (pending !== null && pending !== undefined) {
          return BigInt(pending);
        }
      }

      const authorizations = await readStorage(`identity.authorizations of ${userKey}`, () =>
        api.query.identity.authorizations.entries({ Account: userKey })
      );
      let latest: { authId: number; limit: bigint } | undefined;

      for (const [key, value] of authorizations) {
        const data = field(
          value.toJSON() as Record<string, unknown> | null,
          'authorizationdata'
        ) as Record<string, unknown> | undefined;
        const [type, offer] = Object.entries(data ?? {})[0] ?? [];

        if (
          type &&
          PAYING_KEY_OFFERS.has(type.toLowerCase()) &&
          Array.isArray(offer) &&
          offer[1] === payingKey
        ) {
          const authId = Number(key.args[1].toString());

          if (!latest || authId > latest.authId) {
            latest = { authId, limit: BigInt(String(offer[2])) };
          }
        }
      }

      return latest?.limit;
    }
  );

/**
 * Ends what `subsidy` holds, the subsidy or an offer. The chain keeps an offer apart from the
 * subsidy it would replace, and one row holds the pair, so an offer the paying key still has
 * pending takes the row over. Otherwise the row is removed, with `remaining` when the event states
 * what was left.
 */
const endOrReoffer = async (
  subsidy: Subsidy,
  block: SubstrateBlock,
  eventIdx: number,
  remaining?: bigint
): Promise<void> => {
  const offer = await readPendingOffer(
    subsidy.beneficiaryAccountId,
    subsidy.payingAccountId,
    block,
    eventIdx
  );

  if (offer === undefined) {
    subsidy.isRemoved = true;
    if (remaining !== undefined) {
      subsidy.allowance = remaining;
    }

    return;
  }

  subsidy.isAccepted = false;
  subsidy.isRemoved = false;
  subsidy.allowance = offer;
  // see `handleSubsidyApproved`
  subsidy.totalDebited = is8xChain(block) ? BigInt(0) : undefined;
};

/**
 * An offer from `payingKey` to `userKey` was withdrawn, rejected or given up on. A live subsidy
 * goes on; a row that holds an offer ends it, or shows another offer still pending.
 */
export const endSubsidyOffer = async (
  userKey: string,
  payingKey: string,
  block: SubstrateBlock,
  eventIdx: number,
  blockEventId: string
): Promise<void> => {
  const subsidy = await Subsidy.get(subsidyId(userKey, payingKey));

  if (!subsidy || subsidy.isAccepted || subsidy.isRemoved) {
    return;
  }

  await endOrReoffer(subsidy, block, eventIdx);
  subsidy.updatedEventId = blockEventId;

  await subsidy.save();
};

/**
 * Acceptance is on-chain proof the subsidy exists, so a missing row is created here rather than
 * reported as missing.
 *
 * `relayer.set_paying_key` emits `AuthorizedPayingKey`, which `handleSubsidyApproved` turns into
 * the row — but the same authorization can be raised through `identity.add_authorization` with
 * `AuthorizationData::AddRelayerPayingKey`, which emits only `identity.AuthorizationAdded` and no
 * relayer event at all. Nothing then created the row, and every later `SubsidyDebited` /
 * `RemovedPayingKey` for it would have reported it missing too. Seen on testnet at block
 * 1,747,041, accepting authorization `0000002617`.
 */
export const handleSubsidyAccepted = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockId, blockEventId, eventIdx } = extractArgs(event);
  const decoded = decodeEvent(event);
  const { userKey: rawUserKey, payingKey: rawPayingKey } = decoded;

  const userKey = getTextValue(rawUserKey);
  const payingKey = getTextValue(rawPayingKey);
  const id = subsidyId(userKey, payingKey);

  let subsidy = await Subsidy.get(id);

  if (!subsidy) {
    await ensureAccounts(userKey, payingKey, blockId, blockTime(block), blockEventId);

    subsidy = Subsidy.create({
      id,
      beneficiaryAccountId: userKey,
      payingAccountId: payingKey,
      allowance: BigInt(0),
      // see `handleSubsidyApproved` — pre-v8 there is nothing to accumulate from
      totalDebited: is8xChain(block) ? BigInt(0) : undefined,
      isAccepted: false,
      isRemoved: false,
      createdEventId: blockEventId,
      updatedEventId: blockEventId,
    });
  }

  // Accepting replaces whatever subsidy the user had, and the chain removes the old one first. When
  // the old one had the same paying key, its removal has just ended this same row, so acceptance
  // has to make it live again.
  subsidy.isAccepted = true;
  subsidy.isRemoved = false;

  // v8+ `AcceptedSubsidy` repeats the limit. Pre-v8 `AcceptedPayingKey` does not carry one, and the
  // offer accepted need not be the one the row shows: several can be pending, and one may have
  // been made while a subsidy was live. So the chain's own figure is read.
  subsidy.allowance =
    'initialPolyxLimit' in decoded
      ? getBigIntValue(decoded.initialPolyxLimit)
      : (await readChainAllowance(userKey, payingKey, block, eventIdx)) ?? subsidy.allowance;
  subsidy.updatedEventId = blockEventId;

  await subsidy.save();
};

export const handleSubsidyRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId, eventId, eventIdx } = extractArgs(event);
  const decoded = decodeEvent(event);
  const userKey = getTextValue(decoded.userKey);
  const payingKey = getTextValue(decoded.payingKey);

  // a withdrawn offer, which leaves the subsidy it would have replaced
  if (eventId === EventIdEnum.RemovedPendingSubsidy) {
    await endSubsidyOffer(userKey, payingKey, block, eventIdx, blockEventId);

    return;
  }

  const subsidy = await getSubsidyOrAnomaly(userKey, payingKey, event);

  if (!subsidy) {
    return;
  }

  // `RemovedSubsidy` states the allowance left at the moment it ended — more exact than whatever the
  // last `UpdatedPolyxLimit` or debit left behind. `RemovedPayingKey` carries no such figure.
  await endOrReoffer(
    subsidy,
    block,
    eventIdx,
    'remaining' in decoded ? getBigIntValue(decoded.remaining) : undefined
  );
  subsidy.updatedEventId = blockEventId;

  await subsidy.save();
};

export const handleSubsidyDebited = async (event: SubstrateEvent): Promise<void> => {
  const { blockEventId } = extractArgs(event);
  const { userKey: rawUserKey, payingKey: rawPayingKey, amount: rawAmount } = decodeEvent(event);

  const subsidy = await getSubsidyOrAnomaly(
    getTextValue(rawUserKey),
    getTextValue(rawPayingKey),
    event
  );

  if (!subsidy) {
    return;
  }

  const amount = getBigIntValue(rawAmount);

  // A row created pre-v8 carries no running total; this event only exists from v8, so the first
  // one to reach such a row starts the count rather than adding to nothing.
  subsidy.totalDebited = (subsidy.totalDebited ?? BigInt(0)) + amount;
  subsidy.allowance -= amount;
  subsidy.updatedEventId = blockEventId;

  await subsidy.save();
};

export const handlePolyxLimitUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { blockEventId } = extractArgs(event);
  const {
    userKey: rawUserKey,
    payingKey: rawPayingKey,
    remaining: rawRemaining,
  } = decodeEvent(event);

  const subsidy = await getSubsidyOrAnomaly(
    getTextValue(rawUserKey),
    getTextValue(rawPayingKey),
    event
  );

  if (!subsidy) {
    return;
  }

  subsidy.allowance = getBigIntValue(rawRemaining);
  subsidy.updatedEventId = blockEventId;

  await subsidy.save();
};
