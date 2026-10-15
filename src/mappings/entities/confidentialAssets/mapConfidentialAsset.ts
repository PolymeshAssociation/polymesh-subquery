import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import {
  ConfidentialAccountAsset,
  ConfidentialAsset,
  ConfidentialAssetKey,
  ConfidentialKeyRole,
} from '../../../types';
import {
  bytesToString,
  getAllByFields,
  getBigIntValue,
  getNumberValue,
  getStringArrayValue,
  getTextValue,
} from '../../../utils';
import { extractArgs } from '../common';

type AssetKey = Pick<
  ConfidentialAssetKey,
  'id' | 'assetId' | 'role' | 'accountId' | 'encryptionKeyId'
>;

/**
 * An asset's auditor and mediator keys, one row per key and role. Mediators are emitted as a map
 * of confidential account public key -> encryption public key; auditors as encryption keys.
 */
export const confidentialAssetKeys = (
  assetId: string,
  mediators: Record<string, string>,
  auditors: string[]
): AssetKey[] => [
  ...Object.entries(mediators).map(([accountId, encryptionKeyId]) => ({
    // the map is keyed by account, and two mediator accounts may share an encryption key
    id: `${assetId}/${ConfidentialKeyRole.Mediator}/${accountId}`,
    assetId,
    role: ConfidentialKeyRole.Mediator,
    accountId,
    encryptionKeyId,
  })),
  ...auditors.map(encryptionKeyId => ({
    id: `${assetId}/${ConfidentialKeyRole.Auditor}/${encryptionKeyId}`,
    assetId,
    role: ConfidentialKeyRole.Auditor,
    accountId: undefined,
    encryptionKeyId,
  })),
];

const assetKeysOf = (assetId: string, rawMediators: Codec, rawAuditors: Codec): AssetKey[] =>
  confidentialAssetKeys(
    assetId,
    rawMediators.toJSON() as Record<string, string>,
    getStringArrayValue(rawAuditors)
  );

const createAssetKeys = (keys: AssetKey[], blockEventId: string): Promise<void> =>
  keys.length > 0
    ? store.bulkCreate(
        'ConfidentialAssetKey',
        keys.map(key => ({ ...key, createdEventId: blockEventId }))
      )
    : Promise.resolve();

export const handleConfidentialAssetCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockEventId } = extractArgs(event);

  const [rawDid, rawAssetId, rawMediators, rawAuditors, rawName, rawSymbol, rawDecimals, rawData] =
    params;

  const assetId = getTextValue(rawAssetId);

  await ConfidentialAsset.create({
    id: assetId,
    assetId: getNumberValue(rawAssetId),
    name: bytesToString(rawName),
    symbol: bytesToString(rawSymbol),
    decimals: getNumberValue(rawDecimals),
    data: bytesToString(rawData),
    creatorId: getTextValue(rawDid),
    totalSupply: BigInt(0),
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();
  await createAssetKeys(assetKeysOf(assetId, rawMediators, rawAuditors), blockEventId);
};

export const handleConfidentialAssetUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockEventId } = extractArgs(event);

  const [, rawAssetId, rawMediators, rawAuditors] = params;

  const asset = await ConfidentialAsset.get(getTextValue(rawAssetId));

  if (asset) {
    const current = await getAllByFields<ConfidentialAssetKey>('ConfidentialAssetKey', [
      ['assetId', '=', asset.id],
    ]);
    const keys = assetKeysOf(asset.id, rawMediators, rawAuditors);
    // only what changed, so a key the update keeps keeps the event that added it
    const kept = new Set(keys.map(key => key.id));
    const existing = new Set(current.map(key => key.id));
    const dropped = current.filter(key => !kept.has(key.id)).map(key => key.id);
    if (dropped.length > 0) {
      await store.bulkRemove('ConfidentialAssetKey', dropped);
    }
    await createAssetKeys(
      keys.filter(key => !existing.has(key.id)),
      blockEventId
    );

    asset.updatedEventId = blockEventId;
    await asset.save();
  }
};

export const handleConfidentialAssetMinted = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockEventId } = extractArgs(event);

  const [, rawAssetId, , rawTotalSupply] = params;

  const asset = await ConfidentialAsset.get(getTextValue(rawAssetId));

  if (asset) {
    asset.totalSupply = getBigIntValue(rawTotalSupply);
    asset.updatedEventId = blockEventId;

    await asset.save();
  }
};

export const handleConfidentialAccountAssetRegistered = async (
  event: SubstrateEvent
): Promise<void> => {
  const { params, blockEventId } = extractArgs(event);

  const [, rawAccount, rawAssetId] = params;

  const accountId = getTextValue(rawAccount);
  const assetId = getTextValue(rawAssetId);

  await ConfidentialAccountAsset.create({
    id: `${assetId}/${accountId}`,
    accountId,
    assetId,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();
};
