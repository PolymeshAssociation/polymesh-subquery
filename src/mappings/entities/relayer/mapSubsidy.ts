import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { AnomalyKind, Subsidy } from '../../../types';
import { getBigIntValue, getOrCreateAccount, getTextValue, recordAnomaly } from '../../../utils';
import { extractArgs } from '../common';

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

export const handleSubsidyApproved = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockId, blockEventId } = extractArgs(event);
  const {
    userKey: rawUserKey,
    payingKey: rawPayingKey,
    initialPolyxLimit: rawLimit,
  } = decodeEvent(event);

  const userKey = getTextValue(rawUserKey);
  const payingKey = getTextValue(rawPayingKey);

  await ensureAccounts(userKey, payingKey, blockId, block.timestamp, blockEventId);

  await Subsidy.create({
    id: subsidyId(userKey, payingKey),
    beneficiaryAccountId: userKey,
    payingAccountId: payingKey,
    allowance: getBigIntValue(rawLimit),
    totalDebited: BigInt(0),
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
const getSubsidyOrAnomaly = async (
  userKey: string,
  payingKey: string,
  event: SubstrateEvent
): Promise<Subsidy | undefined> => {
  const id = subsidyId(userKey, payingKey);
  const subsidy = await Subsidy.get(id);

  if (subsidy) {
    return subsidy;
  }

  const { block, eventIdx, moduleId, eventId } = extractArgs(event);

  await recordAnomaly({
    kind: AnomalyKind.MissingReferencedEntity,
    detail: `${eventId} found no Subsidy at id "${id}"`,
    block,
    eventIdx,
    moduleId,
    eventId,
  });

  return undefined;
};

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
    await ensureAccounts(userKey, payingKey, blockId, block.timestamp, blockEventId);

    subsidy = Subsidy.create({
      id,
      beneficiaryAccountId: userKey,
      payingAccountId: payingKey,
      allowance: (await readChainAllowance(userKey)) ?? BigInt(0),
      totalDebited: BigInt(0),
      isAccepted: false,
      isRemoved: false,
      createdEventId: blockEventId,
      updatedEventId: blockEventId,
    });
  }

  subsidy.isAccepted = true;

  // v8+ `AcceptedSubsidy` repeats the limit; pre-v8 `AcceptedPayingKey` does not carry one, so
  // the allowance `handleSubsidyApproved` already set stands.
  if ('initialPolyxLimit' in decoded) {
    subsidy.allowance = getBigIntValue(decoded.initialPolyxLimit);
  }
  subsidy.updatedEventId = blockEventId;

  await subsidy.save();
};

export const handleSubsidyRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { blockEventId } = extractArgs(event);
  const { userKey: rawUserKey, payingKey: rawPayingKey } = decodeEvent(event);

  const subsidy = await getSubsidyOrAnomaly(
    getTextValue(rawUserKey),
    getTextValue(rawPayingKey),
    event
  );

  if (!subsidy) {
    return;
  }

  subsidy.isRemoved = true;
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

  subsidy.totalDebited += amount;
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
