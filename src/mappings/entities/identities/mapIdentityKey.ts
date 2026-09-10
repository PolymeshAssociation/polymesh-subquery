import { EventIdEnum, IdentityKey, KeyRole, PermissionsJson } from '../../../types';
import { getAllByFields, padId } from '../../../utils';

/**
 * `IdentityKey` — an append-only key-rotation history (defect G3).
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
): string => `${identityId}/${address}/${fromBlockId}/${padId(`${eventIdx}`)}`;

interface OpenArgs {
  identityId: string;
  address: string;
  role: KeyRole;
  /** Granted permissions for this interval. Left null for a primary key, which always has full permission. */
  permissions?: PermissionsJson;
  addedReason: EventIdEnum;
  eventIdx: number;
}

/** Opens a membership interval. `blockId` is the padded block id, which also dates `validFromBlock`. */
export const openIdentityKey = async (
  { identityId, address, role, permissions, addedReason, eventIdx }: OpenArgs,
  blockId: string
): Promise<void> => {
  await IdentityKey.create({
    id: identityKeyId(identityId, address, blockId, eventIdx),
    identityId,
    accountId: address,
    role,
    permissions,
    validFromBlockId: blockId,
    addedReason,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

/** The open interval(s) for an account, optionally narrowed to one role. */
const openIntervals = async (address: string, role?: KeyRole): Promise<IdentityKey[]> => {
  const rows = await getAllByFields<IdentityKey>('IdentityKey', [['accountId', '=', address]]);

  return rows.filter(
    row => row.validToBlockId == null && (role === undefined || row.role === role)
  );
};

interface CloseArgs {
  address: string;
  role?: KeyRole;
  removedReason: EventIdEnum;
}

/** Closes every open interval for an account (optionally of one role); returns the rows it closed. */
export const closeIdentityKeys = async (
  { address, role, removedReason }: CloseArgs,
  blockId: string
): Promise<IdentityKey[]> => {
  const open = await openIntervals(address, role);

  if (open.length === 0) {
    return open;
  }

  open.forEach(row => {
    row.validToBlockId = blockId;
    row.removedReason = removedReason;
    row.updatedBlockId = blockId;
  });

  // `getAllByFields` returns plain rows, not entity instances — updates go back through the store.
  await store.bulkUpdate('IdentityKey', open);

  return open;
};

interface RotateArgs {
  address: string;
  role: KeyRole;
  reason: EventIdEnum;
  eventIdx: number;
  permissions?: PermissionsJson;
  /** Falls back to the closed interval's identity when omitted — a permissions change keeps the DID. */
  identityId?: string;
}

/**
 * Closes an account's open interval and opens a fresh one — a permissions change or a primary-key
 * rotation, where the membership continues but its terms change.
 */
export const rotateIdentityKey = async (
  { address, role, reason, eventIdx, permissions, identityId }: RotateArgs,
  blockId: string
): Promise<void> => {
  const [closed] = await closeIdentityKeys({ address, role, removedReason: reason }, blockId);

  const owningIdentity = identityId ?? closed?.identityId;

  if (!owningIdentity) {
    return;
  }

  await openIdentityKey(
    { identityId: owningIdentity, address, role, permissions, addedReason: reason, eventIdx },
    blockId
  );
};
