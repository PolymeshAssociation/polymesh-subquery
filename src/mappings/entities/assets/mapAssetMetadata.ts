import { SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
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

type MetadataKey = { scope: MetadataScope; keyId: string };

/** `{ Local: n } | { Global: n }`, from an event param or an extrinsic arg. */
const parseMetadataKey = (raw: unknown): MetadataKey | undefined => {
  const obj = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
  if (obj && ('local' in obj || 'Local' in obj)) {
    return { scope: MetadataScope.Local, keyId: String(obj.local ?? obj.Local) };
  }
  if (obj && ('global' in obj || 'Global' in obj)) {
    return { scope: MetadataScope.Global, keyId: String(obj.global ?? obj.Global) };
  }
  return undefined;
};

/**
 * `SetAssetMetadataValue` / `...ValueDetails` do not carry the metadata key. It is recovered from
 * either the call args or a sibling event, in that order:
 *
 * 1. a direct `asset.setAssetMetadata` / `setAssetMetadataDetails` call — the key is `args[1]`;
 * 2. `asset.registerAndSetLocalAssetMetadata`, which registers the key and sets its value in one
 *    call and so emits `RegisterAssetMetadataLocalType` in the same extrinsic, just before this
 *    event — that carries the new key id.
 *
 * Only when neither resolves (an unrecognised wrapper) is the row dropped with an anomaly.
 */
const metadataKeyFromExtrinsic = (
  extrinsic: SubstrateExtrinsic | undefined
): MetadataKey | undefined => {
  const method = extrinsic?.extrinsic.method;
  if (
    method?.section !== 'asset' ||
    (method.method !== 'setAssetMetadata' && method.method !== 'setAssetMetadataDetails')
  ) {
    return undefined;
  }
  return parseMetadataKey(extrinsic.extrinsic.args[1]?.toJSON());
};

/** The fields of a block `EventRecord` this module reads — avoids the CJS/ESM `EventRecord` clash. */
type BlockEventRecord = {
  event: { section: string; method: string };
  phase: { isApplyExtrinsic: boolean; asApplyExtrinsic: { toNumber: () => number } };
};

const isFromExtrinsic = (record: BlockEventRecord, extrinsicIdx: number | undefined): boolean =>
  extrinsicIdx !== undefined &&
  record.phase.isApplyExtrinsic &&
  record.phase.asApplyExtrinsic.toNumber() === extrinsicIdx;

/**
 * The key id from a `RegisterAssetMetadata{Local,Global}Type` emitted earlier in the same
 * extrinsic — the `register-and-set` path, where the setter event has no key of its own.
 */
const metadataKeyFromSiblingRegistration = (event: SubstrateEvent): MetadataKey | undefined => {
  const events = event.block.events as unknown as BlockEventRecord[];
  const siblingIdx = events.findIndex(
    record =>
      record.event.section === 'asset' &&
      (record.event.method === 'RegisterAssetMetadataLocalType' ||
        record.event.method === 'RegisterAssetMetadataGlobalType') &&
      isFromExtrinsic(record, event.extrinsic?.idx)
  );

  if (siblingIdx === -1) {
    return undefined;
  }

  const sibling = events[siblingIdx];
  const decoded = decodeEvent({
    ...event,
    idx: siblingIdx,
    event: sibling.event,
  } as unknown as SubstrateEvent);

  return sibling.event.method === 'RegisterAssetMetadataLocalType'
    ? { scope: MetadataScope.Local, keyId: getTextValue(decoded.localKeyId) }
    : { scope: MetadataScope.Global, keyId: getTextValue(decoded.globalKeyId) };
};

const resolveMetadataKey = (event: SubstrateEvent): MetadataKey | undefined =>
  metadataKeyFromExtrinsic(event.extrinsic) ?? metadataKeyFromSiblingRegistration(event);

const metadataId = (assetId: string, key: MetadataKey): string =>
  `${assetId}/${key.scope}/${key.keyId}`;

const detailFrom = (rawDetail: unknown): { isLocked: boolean; expiry: Date | undefined } => {
  const detail = rawDetail as { expire?: number | null; lockStatus?: unknown } | null;
  if (!detail) {
    return { isLocked: false, expiry: undefined };
  }
  const lock = detail.lockStatus;
  const isLocked = typeof lock === 'string' ? lock !== 'Unlocked' : lock != null;
  const expiry = detail.expire ? new Date(Number(detail.expire)) : undefined;
  return { isLocked, expiry };
};

const upsertMetadata = async (
  assetId: string,
  key: MetadataKey,
  blockId: string,
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
      createdBlockId: blockId,
      updatedBlockId: blockId,
    });

  if (key.scope === MetadataScope.Global && !row.name) {
    row.name = (await GlobalMetadataKey.get(key.keyId))?.name;
  }

  apply(row);
  row.updatedBlockId = blockId;
  await row.save();
};

export const handleRegisterAssetMetadataLocalType = async (
  event: SubstrateEvent
): Promise<void> => {
  const { blockId, block } = extractArgs(event);
  const { assetId: rawAssetId, name: rawName, localKeyId: rawKeyId } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  await getAsset(assetId);

  await upsertMetadata(
    assetId,
    { scope: MetadataScope.Local, keyId: getTextValue(rawKeyId) },
    blockId,
    row => {
      row.name = bytesToString(rawName);
    }
  );
};

export const handleRegisterAssetMetadataGlobalType = async (
  event: SubstrateEvent
): Promise<void> => {
  const { blockId } = extractArgs(event);
  const { name: rawName, globalKeyId: rawKeyId, spec: rawSpec } = decodeEvent(event);

  const id = getTextValue(rawKeyId);
  const row =
    (await GlobalMetadataKey.get(id)) ??
    GlobalMetadataKey.create({
      id,
      name: bytesToString(rawName),
      createdBlockId: blockId,
      updatedBlockId: blockId,
    });

  row.name = bytesToString(rawName);
  row.spec = rawSpec.isEmpty ? undefined : JSON.stringify(rawSpec.toJSON());
  row.updatedBlockId = blockId;
  await row.save();
};

export const handleGlobalMetadataSpecUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { blockId } = extractArgs(event);
  const { name: rawName, spec: rawSpec } = decodeEvent(event);

  // the event carries the name, not the id; match on the indexed name
  const name = bytesToString(rawName);
  const [match] = await GlobalMetadataKey.getByName(name, { limit: 1, offset: 0 });
  if (match) {
    match.spec = rawSpec.isEmpty ? undefined : JSON.stringify(rawSpec.toJSON());
    match.updatedBlockId = blockId;
    await match.save();
  }
};

export const handleSetAssetMetadataValue = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block } = extractArgs(event);
  const { assetId: rawAssetId, value: rawValue, detail: rawDetail } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const key = resolveMetadataKey(event);

  if (!key) {
    await recordAnomaly({
      kind: AnomalyKind.MissingReferencedEntity,
      detail: `SetAssetMetadataValue for asset ${assetId} could not resolve its metadata key from the extrinsic or a sibling registration event`,
      block,
      eventIdx: event.idx,
    });
    return;
  }

  const { isLocked, expiry } = detailFrom(rawDetail?.isEmpty ? null : rawDetail?.toJSON());

  await upsertMetadata(assetId, key, blockId, row => {
    row.value = bytesToString(rawValue);
    row.isLocked = isLocked;
    row.expiry = expiry;
  });
};

export const handleSetAssetMetadataValueDetails = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block } = extractArgs(event);
  const { assetId: rawAssetId, detail: rawDetail } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const key = resolveMetadataKey(event);
  if (!key) {
    return;
  }

  const { isLocked, expiry } = detailFrom(rawDetail?.toJSON());

  await upsertMetadata(assetId, key, blockId, row => {
    row.isLocked = isLocked;
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
  const { blockId, block } = extractArgs(event);
  const { assetId: rawAssetId, key: rawKey } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const key = parseMetadataKey(rawKey.toJSON());
  if (!key) {
    return;
  }

  const row = await AssetMetadata.get(metadataId(assetId, key));
  if (row) {
    row.value = undefined;
    row.isLocked = false;
    row.expiry = undefined;
    row.updatedBlockId = blockId;
    await row.save();
  }
};

export const handleAssetTypeChanged = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block } = extractArgs(event);
  const { assetId: rawAssetId, assetType: rawType } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const asset = await getAsset(assetId);

  asset.type = await getAssetType(rawType);
  asset.updatedBlockId = blockId;
  await asset.save();
};

const upsertCustomAssetType = async (event: SubstrateEvent): Promise<void> => {
  const { blockId } = extractArgs(event);
  const { typeId: rawTypeId, name: rawName } = decodeEvent(event);

  const id = getNumberValue(rawTypeId).toString();
  const existing = await CustomAssetType.get(id);

  if (existing) {
    return;
  }

  await CustomAssetType.create({
    id,
    name: bytesToString(rawName),
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const handleCustomAssetTypeRegistered = upsertCustomAssetType;
export const handleCustomAssetTypeExists = upsertCustomAssetType;
