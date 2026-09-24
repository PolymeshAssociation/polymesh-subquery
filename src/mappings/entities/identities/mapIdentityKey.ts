import { SubstrateBlock } from '@subql/types';
import { AnomalyKind, EventIdEnum, IdentityKey, IdentityKeyRole, PermissionsJson } from '../../../types';
import { getAllByFields, padId } from '../../../utils';
import { recordAnomaly } from '../../../utils/anomaly';

/**
 * `IdentityKey` — an append-only key-rotation history.
 *
 * A key joining an identity opens an interval (`validFromBlock` set, `validToBlock` null); leaving,
 * being rotated out, or a permissions change closes it. A permissions change and a primary-key
 * rotation also open a fresh interval, so a key's terms over time are a listable history rather
 * than an overwrite.
 *
 * `Boolean` cannot be indexed on the Postgres in use, so "currently active" is the rows whose
 * `validToBlockId` is null — the composite index `[account, validToBlock]` covers that lookup.
 */

const identityKeyId = (
  identityId: string,
  address: string,
  fromBlockId: string,
  eventIdx: number
): string => {
  const paddedEventIdx = padId(String(eventIdx));

  return `${identityId}/${address}/${fromBlockId}/${paddedEventIdx}`;
};

interface OpenArgs {
  identityId: string;
  address: string;
  role: IdentityKeyRole;
  /** Granted permissions for this interval. Left null for a primary key, which always has full permission. */
  permissions?: PermissionsJson;
  addedReason: EventIdEnum;
  eventIdx: number;
}

/**
 * Opens a membership interval. `blockEventId` is `padId(block)/padId(eventIdx)`; its block half
 * dates `validFromBlock`, and the whole id is the provenance `createdEvent`.
 */
export const openIdentityKey = async (
  { identityId, address, role, permissions, addedReason, eventIdx }: OpenArgs,
  blockEventId: string
): Promise<void> => {
  const blockId = blockEventId.split('/')[0];
  await IdentityKey.create({
    id: identityKeyId(identityId, address, blockId, eventIdx),
    identityId,
    accountId: address,
    role,
    permissions,
    validFromBlockId: blockId,
    addedReason,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();
};

/** The open interval(s) for an account, optionally narrowed to one role. */
const openIntervals = async (address: string, role?: IdentityKeyRole): Promise<IdentityKey[]> => {
  const rows = await getAllByFields<IdentityKey>('IdentityKey', [['accountId', '=', address]]);

  return rows.filter(
    row => row.validToBlockId == null && (role === undefined || row.role === role)
  );
};

interface CloseArgs {
  address: string;
  role?: IdentityKeyRole;
  removedReason: EventIdEnum;
}

/** Closes every open interval for an account (optionally of one role); returns the rows it closed. */
export const closeIdentityKeys = async (
  { address, role, removedReason }: CloseArgs,
  blockEventId: string
): Promise<IdentityKey[]> => {
  const blockId = blockEventId.split('/')[0];
  const open = await openIntervals(address, role);

  if (open.length === 0) {
    return open;
  }

  open.forEach(row => {
    row.validToBlockId = blockId;
    row.removedReason = removedReason;
    row.updatedEventId = blockEventId;
  });

  // One round trip for the whole set rather than a `.save()` each.
  await store.bulkUpdate('IdentityKey', open);

  return open;
};

interface RotateArgs {
  address: string;
  role: IdentityKeyRole;
  reason: EventIdEnum;
  eventIdx: number;
  permissions?: PermissionsJson;
  /** Falls back to the closed interval's identity when omitted — a permissions change keeps the DID. */
  identityId?: string;
  /** For the anomaly recorded when there is no membership to carry forward. */
  block: SubstrateBlock;
}

/**
 * Closes an account's open interval and opens a fresh one — a permissions change or a primary-key
 * rotation, where the membership continues but its terms change.
 *
 * One interval is reopened per interval closed, each on its own identity: closing every open
 * interval and reopening only the first would leave the key with memberships the chain still
 * considers active. Finding nothing to carry forward is a gap in the index rather than a
 * no-op — the close has already happened by then, and the new terms would be recorded nowhere —
 * so it is reported rather than swallowed.
 */
export const rotateIdentityKey = async (
  { address, role, reason, eventIdx, permissions, identityId, block }: RotateArgs,
  blockEventId: string
): Promise<void> => {
  const closed = await closeIdentityKeys({ address, role, removedReason: reason }, blockEventId);

  const owners =
    closed.length > 0
      ? closed.map(row => identityId ?? row.identityId)
      : identityId
      ? [identityId]
      : [];

  if (owners.length === 0) {
    await recordAnomaly({
      kind: AnomalyKind.MissingReferencedEntity,
      detail: `${reason} on account ${address} found no membership interval to carry forward`,
      block,
      eventIdx,
    });

    return;
  }

  await Promise.all(
    owners.map(owner =>
      openIdentityKey(
        { identityId: owner, address, role, permissions, addedReason: reason, eventIdx },
        blockEventId
      )
    )
  );
};
