import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import {
  AnomalyKind,
  AssetMetadata,
  CustomAssetType,
  GlobalMetadataKey,
  MetadataScope,
} from '../../../types';
import {
  bytesToString,
  getAssetId,
  getAssetType,
  getNumberValue,
  getTextValue,
} from '../../../utils';
import { recordAnomaly } from '../../../utils/anomaly';
import { extractArgs, getAsset } from '../common';
import { MetadataKey, parseMetadataKey, resolveMetadataKey } from './metadataKeyResolver';

const metadataId = (assetId: string, key: MetadataKey): string =>
  `${assetId}/${key.scope}/${key.keyId}`;

interface ValueDetail {
  isLocked: boolean;
  lockedUntil: Date | undefined;
  expiry: Date | undefined;
}

/**
 * `AssetMetadataValueDetail { expire, lock_status }`, where `lock_status` is
 * `Unlocked | Locked | LockedUntil(Moment)` (primitives `asset_metadata.rs`). The `LockedUntil`
 * moment is kept: the chain emits nothing when that lock ends, so without it `isLocked` stayed
 * true for good and nothing said when the value became editable again.
 */
const detailFrom = (rawDetail: unknown): ValueDetail => {
  const detail = rawDetail as { expire?: number | null; lockStatus?: unknown } | null;
  if (!detail) {
    return { isLocked: false, lockedUntil: undefined, expiry: undefined };
  }
  const lock = detail.lockStatus;
  const isLocked = typeof lock === 'string' ? lock !== 'Unlocked' : lock != null;
  const until =
    lock && typeof lock === 'object'
      ? (lock as { lockedUntil?: number | string }).lockedUntil
      : undefined;
  const lockedUntil = until !== undefined && until !== null ? new Date(Number(until)) : undefined;
  const expiry = detail.expire ? new Date(Number(detail.expire)) : undefined;
  return { isLocked, lockedUntil, expiry };
};

const upsertMetadata = async (
  assetId: string,
  key: MetadataKey,
  blockEventId: string,
  apply: (row: AssetMetadata) => void
): Promise<void> => {
  const id = metadataId(assetId, key);
  const row =
    (await AssetMetadata.get(id)) ??
    AssetMetadata.create({
      id,
      assetId,
      scope: key.scope,
      keyId: key.keyId,
      isLocked: false,
      createdEventId: blockEventId,
      updatedEventId: blockEventId,
    });

  if (key.scope === MetadataScope.Global && !row.name) {
    row.name = (await GlobalMetadataKey.get(key.keyId))?.name;
  }

  apply(row);
  row.updatedEventId = blockEventId;
  await row.save();
};

/**
 * Why an event could not be matched to the call that set it. A scheduler-dispatched call has no
 * extrinsic to walk at all, so it is unreachable by construction rather than a gap in the walk —
 * worth telling apart when reading the anomaly table.
 */
const unresolvedKeyDetail = (event: SubstrateEvent, eventName: string, assetId: string): string =>
  event.extrinsic
    ? `${eventName} for asset ${assetId} could not be matched to the call that set it`
    : `${eventName} for asset ${assetId} was dispatched without an extrinsic (scheduler or block initialisation), so it carries no call to read the key from`;

export const handleRegisterAssetMetadataLocalType = async (
  event: SubstrateEvent
): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { assetId: rawAssetId, name: rawName, localKeyId: rawKeyId } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  await getAsset(assetId);

  await upsertMetadata(
    assetId,
    { scope: MetadataScope.Local, keyId: getTextValue(rawKeyId) },
    blockEventId,
    row => {
      row.name = bytesToString(rawName);
    }
  );
};

export const handleRegisterAssetMetadataGlobalType = async (
  event: SubstrateEvent
): Promise<void> => {
  const { blockEventId } = extractArgs(event);
  const { name: rawName, globalKeyId: rawKeyId, spec: rawSpec } = decodeEvent(event);

  const id = getTextValue(rawKeyId);
  const row =
    (await GlobalMetadataKey.get(id)) ??
    GlobalMetadataKey.create({
      id,
      name: bytesToString(rawName),
      createdEventId: blockEventId,
      updatedEventId: blockEventId,
    });

  row.name = bytesToString(rawName);
  row.spec = rawSpec.isEmpty ? undefined : JSON.stringify(rawSpec.toJSON());
  row.updatedEventId = blockEventId;
  await row.save();
};

export const handleGlobalMetadataSpecUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { blockEventId } = extractArgs(event);
  const { name: rawName, spec: rawSpec } = decodeEvent(event);

  // The event carries the name, not the id. Matching on the indexed name is exact: the chain
  // refuses to register a global name twice (`AssetMetadataGlobalNameToKey` is checked first, v8.0.0)
  // and has no rename.
  const name = bytesToString(rawName);
  const [match] = await GlobalMetadataKey.getByName(name, { limit: 1, offset: 0 });
  if (match) {
    match.spec = rawSpec.isEmpty ? undefined : JSON.stringify(rawSpec.toJSON());
    match.updatedEventId = blockEventId;
    await match.save();
  }
};

export const handleSetAssetMetadataValue = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { assetId: rawAssetId, value: rawValue, detail: rawDetail } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const key = await resolveMetadataKey(event);

  if (!key) {
    await recordAnomaly({
      kind: AnomalyKind.MissingReferencedEntity,
      detail: unresolvedKeyDetail(event, 'SetAssetMetadataValue', assetId),
      block,
      eventIdx: event.idx,
    });
    return;
  }

  // A `None` detail leaves the stored details untouched on chain, so it must not clear an
  // existing lock or expiry here — only a `Some` detail replaces them.
  const detail = rawDetail?.isEmpty ? undefined : detailFrom(rawDetail?.toJSON());

  await upsertMetadata(assetId, key, blockEventId, row => {
    row.value = bytesToString(rawValue);
    if (detail) {
      row.isLocked = detail.isLocked;
      row.lockedUntil = detail.lockedUntil;
      row.expiry = detail.expiry;
    }
  });
};

export const handleSetAssetMetadataValueDetails = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { assetId: rawAssetId, detail: rawDetail } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const key = await resolveMetadataKey(event);

  if (!key) {
    await recordAnomaly({
      kind: AnomalyKind.MissingReferencedEntity,
      detail: unresolvedKeyDetail(event, 'SetAssetMetadataValueDetails', assetId),
      block,
      eventIdx: event.idx,
    });
    return;
  }

  const { isLocked, lockedUntil, expiry } = detailFrom(rawDetail?.toJSON());

  await upsertMetadata(assetId, key, blockEventId, row => {
    row.isLocked = isLocked;
    row.lockedUntil = lockedUntil;
    row.expiry = expiry;
  });
};

export const handleLocalMetadataKeyDeleted = async (event: SubstrateEvent): Promise<void> => {
  const { block } = extractArgs(event);
  const { assetId: rawAssetId, localKeyId: rawKeyId } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  await AssetMetadata.remove(
    metadataId(assetId, { scope: MetadataScope.Local, keyId: getTextValue(rawKeyId) })
  );
};

export const handleMetadataValueDeleted = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { assetId: rawAssetId, key: rawKey } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const key = parseMetadataKey(rawKey.toJSON());

  if (!key) {
    await recordAnomaly({
      kind: AnomalyKind.MissingReferencedEntity,
      detail: `MetadataValueDeleted for asset ${assetId} carried a key of an unrecognised shape`,
      block,
      eventIdx: event.idx,
    });
    return;
  }

  const row = await AssetMetadata.get(metadataId(assetId, key));
  if (row) {
    row.value = undefined;
    row.isLocked = false;
    row.lockedUntil = undefined;
    row.expiry = undefined;
    row.updatedEventId = blockEventId;
    await row.save();
  }
};

export const handleAssetTypeChanged = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId, eventIdx } = extractArgs(event);
  const { assetId: rawAssetId, assetType: rawType } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const asset = await getAsset(assetId);

  asset.type = await getAssetType(rawType, block, eventIdx);
  asset.updatedEventId = blockEventId;
  await asset.save();
};

const upsertCustomAssetType = async (event: SubstrateEvent): Promise<void> => {
  const { blockEventId } = extractArgs(event);
  const { typeId: rawTypeId, name: rawName } = decodeEvent(event);

  const id = getNumberValue(rawTypeId).toString();
  const existing = await CustomAssetType.get(id);

  if (existing) {
    return;
  }

  await CustomAssetType.create({
    id,
    name: bytesToString(rawName),
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();
};

export const handleCustomAssetTypeRegistered = upsertCustomAssetType;
export const handleCustomAssetTypeExists = upsertCustomAssetType;
