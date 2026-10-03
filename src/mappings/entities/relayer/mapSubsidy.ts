import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { Subsidy } from '../../../types';
import {
  blockTime,
  getBigIntValue,
  getOrCreateAccount,
  getTextValue,
  is8xChain,
} from '../../../utils';
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
 * The allowance the chain records for `userKey` right now.
 *
 * `relayer.subsidies(userKey)` is `Option<{ payingKey, remaining }>`. Only needed on the pre-v8
 * acceptance path, which does not carry a limit in the event — `undefined` on an unreadable or
 * absent entry, which the caller treats as "start at zero" rather than guessing.
 */
const readChainAllowance = async (userKey: string): Promise<bigint | undefined> => {
  try {
    const raw = (await api.query.relayer.subsidies(userKey)).toJSON() as {
      remaining?: string | number;
    } | null;

    return raw?.remaining === undefined ? undefined : BigInt(raw.remaining);
  } catch {
    return undefined;
  }
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
  const { block, blockId, blockEventId } = extractArgs(event);
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
      allowance: (await readChainAllowance(userKey)) ?? BigInt(0),
      // see `handleSubsidyApproved` — pre-v8 there is nothing to accumulate from
      totalDebited: is8xChain(block) ? BigInt(0) : undefined,
      isAccepted: false,
      isRemoved: false,
      createdEventId: blockEventId,
      updatedEventId: blockEventId,
    });
  }

  // Accepting replaces whatever subsidy the user had, and the chain removes the old one first. When
  // the old one had the same paying key, its `RemovedPayingKey` has just marked this same row
  // removed, so acceptance has to make it live again.
  const replacedLive = subsidy.isAccepted && subsidy.isRemoved;

  subsidy.isAccepted = true;
  subsidy.isRemoved = false;

  // v8+ `AcceptedSubsidy` repeats the limit. Pre-v8 `AcceptedPayingKey` does not carry one. The
  // approval's limit stands unless it was not recorded because a subsidy was already live; then
  // the chain's own figure is read.
  if ('initialPolyxLimit' in decoded) {
    subsidy.allowance = getBigIntValue(decoded.initialPolyxLimit);
  } else if (replacedLive) {
    subsidy.allowance = (await readChainAllowance(userKey)) ?? subsidy.allowance;
  }
  subsidy.updatedEventId = blockEventId;

  await subsidy.save();
};

export const handleSubsidyRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { blockEventId } = extractArgs(event);
  const decoded = decodeEvent(event);
  const { userKey: rawUserKey, payingKey: rawPayingKey } = decoded;

  const subsidy = await getSubsidyOrAnomaly(
    getTextValue(rawUserKey),
    getTextValue(rawPayingKey),
    event
  );

  if (!subsidy) {
    return;
  }

  subsidy.isRemoved = true;
  // `RemovedSubsidy` states the allowance left at the moment it ended — more exact than whatever the
  // last `UpdatedPolyxLimit` or debit left behind. The other two removal events carry no such figure.
  if ('remaining' in decoded) {
    subsidy.allowance = getBigIntValue(decoded.remaining);
  }
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
