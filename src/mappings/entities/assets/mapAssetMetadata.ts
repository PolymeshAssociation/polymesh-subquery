import { SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import { decodeEvent } from '../../../decode';
import {
  AnomalyKind,
  AssetMetadata,
  CallIdEnum,
  CustomAssetType,
  GlobalMetadataKey,
  MetadataScope,
  MultiSigProposal,
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

/** `{ Local: n } | { Global: n }`, from an event param or an extrinsic arg. The `n` is a `u64`. */
const parseMetadataKey = (raw: unknown): MetadataKey | undefined => {
  const obj = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, number | string>;
  // `toHuman()` formats a `u64` with thousands separators ("1,234"); `toJSON()` and `getTextValue`
  // do not. Strip them so the same key id round-trips to the same `AssetMetadata` row regardless
  // of which path below resolved it.
  const keyId = (id: number | string): string => `${id}`.replace(/,/g, '');
  if (obj && ('local' in obj || 'Local' in obj)) {
    return { scope: MetadataScope.Local, keyId: keyId(obj.local ?? obj.Local) };
  }
  if (obj && ('global' in obj || 'Global' in obj)) {
    return { scope: MetadataScope.Global, keyId: keyId(obj.global ?? obj.Global) };
  }
  return undefined;
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
 * `event`'s 0-based position among `SetAssetMetadataValue` / `...ValueDetails` siblings dispatched
 * by the same extrinsic. A batch or multisig proposal runs its calls in order and each
 * `setAssetMetadata(Details)` call fires exactly one such event, so this ordinal lines up with
 * that call's own position among the batch's/proposal's `setAssetMetadata(Details)` entries —
 * needed because more than one can target the *same* asset (set now, tighten the lock later),
 * where matching by `asset_id` alone cannot tell them apart.
 */
const metadataSiblingOrdinal = (event: SubstrateEvent): number => {
  const events = event.block.events as unknown as BlockEventRecord[];
  const extrinsicIdx = event.extrinsic?.idx;

  let ordinal = 0;
  for (let i = 0; i < event.idx; i += 1) {
    const record = events[i];
    if (
      record?.event.section === 'asset' &&
      (record.event.method === 'SetAssetMetadataValue' ||
        record.event.method === 'SetAssetMetadataValueDetails') &&
      isFromExtrinsic(record, extrinsicIdx)
    ) {
      ordinal += 1;
    }
  }
  return ordinal;
};

/**
 * `SetAssetMetadataValue` / `...ValueDetails` do not carry the metadata key. It is recovered from
 * either the call args or a sibling event, in that order:
 *
 * 1. a direct `asset.setAssetMetadata` / `setAssetMetadataDetails` call — the key is `args[1]`;
 * 2. the same call, batched alongside others in one `utility.batch*` extrinsic (e.g. `createAsset`
 *    + `setAssetMetadata` for a new asset's initial metadata) — see `metadataKeyFromBatch`;
 * 3. the same call, executed via `multiSig.approve` of a previously-created proposal — see
 *    `metadataKeyFromMultiSigProposal`;
 * 4. `asset.registerAndSetLocalAssetMetadata`, which registers the key and sets its value in one
 *    call and so emits `RegisterAssetMetadataLocalType` in the same extrinsic, just before this
 *    event — that carries the new key id.
 *
 * Only when none resolves (an unrecognised wrapper) is the row dropped with an anomaly.
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

/** One call as `Extrinsic.toHuman().method` shapes it — named, snake_case args. */
type HumanCall = { section: string; method: string; args: Record<string, unknown> };

const isSetMetadataCall = (call: HumanCall): boolean =>
  call.section === 'asset' &&
  (call.method === 'setAssetMetadata' || call.method === 'setAssetMetadataDetails');

/** Every `utility` call that dispatches a `Vec<Call>` in order, including the legacy/forced forms. */
const BATCH_METHODS = [
  'batch',
  'batchAll',
  'batchAtomic',
  'batchOptimistic',
  'forceBatch',
  'batchOld',
];

/**
 * `asset.setAssetMetadata(Details)` batched alongside other calls in one `utility.batch*`
 * extrinsic. The outer, signed extrinsic is `utility.*`, not `asset.*`, so `metadataKeyFromExtrinsic`
 * never matches it — and there is commonly no sibling registration event either, since this usually
 * sets a pre-existing global key rather than registering a new local one. The matching call is
 * picked by ordinal among the batch's own `setAssetMetadata(Details)` entries (`metadataSiblingOrdinal`)
 * and then checked against `assetId` as a consistency guard, so a mismatch (an unexpected call
 * order) falls through to the anomaly rather than writing the wrong asset's key.
 *
 * Pre-7.0 history is out of reach here: `asset_id` never matches a batched call's legacy `ticker`
 * arg, so those fall straight through to the anomaly, same as today.
 */
const metadataKeyFromBatch = (event: SubstrateEvent, assetId: string): MetadataKey | undefined => {
  const extrinsic = event.extrinsic;
  if (!extrinsic) {
    return undefined;
  }

  const method = extrinsic.extrinsic.method;
  if (method.section !== 'utility' || !BATCH_METHODS.includes(method.method)) {
    return undefined;
  }

  const human = extrinsic.extrinsic.toHuman() as { method?: { args?: { calls?: HumanCall[] } } };
  const call = (human.method?.args?.calls ?? []).filter(isSetMetadataCall)[
    metadataSiblingOrdinal(event)
  ];

  return call?.args.asset_id === assetId ? parseMetadataKey(call.args.key) : undefined;
};

/**
 * The same call, executed via `multiSig.approve` of a proposal created earlier. The call never
 * appears on the `approve` extrinsic itself, and `multiSig.proposals` storage is cleared once a
 * proposal executes — but the indexer already captured it at `ProposalAdded` time:
 * `MultiSigProposal.params.proposals` holds the module/call/args of the proposed call (flattened
 * one level if the proposal was itself a batch — a batch-of-batches proposal is not unwrapped
 * further and falls through to the anomaly), keyed `${multisig}/${proposalId}`, exactly what
 * `approve`'s own args carry. Matched the same way as `metadataKeyFromBatch`: by ordinal, then
 * checked against `assetId`.
 */
const metadataKeyFromMultiSigProposal = async (
  event: SubstrateEvent,
  assetId: string
): Promise<MetadataKey | undefined> => {
  const extrinsic = event.extrinsic;
  if (!extrinsic) {
    return undefined;
  }

  const method = extrinsic.extrinsic.method;
  if (method.section !== 'multiSig' || method.method !== 'approve') {
    return undefined;
  }

  const [rawMultiSig, rawProposalId] = extrinsic.extrinsic.args;
  if (!rawMultiSig || !rawProposalId) {
    return undefined;
  }

  // `.toString()` directly, not `getTextValue`/`getNumberValue` — `extrinsic.extrinsic.args`
  // resolves through the `@polkadot/types-codec` cjs build, a distinct (if structurally
  // identical) `Codec` from the esm one those helpers are typed against.
  const proposal = await MultiSigProposal.get(
    `${rawMultiSig.toString()}/${Number(rawProposalId.toString())}`
  );

  const call = (proposal?.params.proposals ?? []).filter(
    p =>
      p.call === CallIdEnum.set_asset_metadata || p.call === CallIdEnum.set_asset_metadata_details
  )[metadataSiblingOrdinal(event)];

  if (!call) {
    return undefined;
  }

  const args = JSON.parse(call.args) as Record<string, unknown>;
  return args.asset_id === assetId ? parseMetadataKey(args.key) : undefined;
};

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

const resolveMetadataKey = async (
  event: SubstrateEvent,
  assetId: string
): Promise<MetadataKey | undefined> =>
  metadataKeyFromExtrinsic(event.extrinsic) ??
  metadataKeyFromBatch(event, assetId) ??
  (await metadataKeyFromMultiSigProposal(event, assetId)) ??
  metadataKeyFromSiblingRegistration(event);

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

  // the event carries the name, not the id; match on the indexed name
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
  const key = await resolveMetadataKey(event, assetId);

  if (!key) {
    await recordAnomaly({
      kind: AnomalyKind.MissingReferencedEntity,
      detail: `SetAssetMetadataValue for asset ${assetId} could not resolve its metadata key from the extrinsic, a batch, a multisig proposal, or a sibling registration event`,
      block,
      eventIdx: event.idx,
    });
    return;
  }

  const { isLocked, expiry } = detailFrom(rawDetail?.isEmpty ? null : rawDetail?.toJSON());

  await upsertMetadata(assetId, key, blockEventId, row => {
    row.value = bytesToString(rawValue);
    row.isLocked = isLocked;
    row.expiry = expiry;
  });
};

export const handleSetAssetMetadataValueDetails = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { assetId: rawAssetId, detail: rawDetail } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const key = await resolveMetadataKey(event, assetId);
  if (!key) {
    return;
  }

  const { isLocked, expiry } = detailFrom(rawDetail?.toJSON());

  await upsertMetadata(assetId, key, blockEventId, row => {
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
  const { block, blockEventId } = extractArgs(event);
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
    row.updatedEventId = blockEventId;
    await row.save();
  }
};

export const handleAssetTypeChanged = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { assetId: rawAssetId, assetType: rawType } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const asset = await getAsset(assetId);

  asset.type = await getAssetType(rawType);
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
