import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import {
  ConfidentialAccountAsset,
  ConfidentialAsset,
  ConfidentialAssetEncryptionKey,
  ConfidentialAssetMediator,
} from '../../../types';
import {
  getAllByFields,
  getBigIntValue,
  getNumberValue,
  getStringArrayValue,
  getTextValue,
} from '../../../utils';
import { extractArgs } from '../common';
import { storedText } from '../../../utils/text';

type AssetEncryptionKey = Pick<
  ConfidentialAssetEncryptionKey,
  'id' | 'assetId' | 'encryptionKeyId'
>;
type AssetMediator = Pick<ConfidentialAssetMediator, 'id' | 'assetId' | 'accountId'>;

/**
 * An asset's encryption keys and mediators, as the chain stores them. The keys are every auditor
 * key plus every mediator's key, deduplicated: the chain keeps them as one set and doesn't record
 * which came from which argument. The mediators are the accounts alone; the chain stops holding
 * which key each one was paired with.
 */
export const confidentialAssetKeyRows = (
  assetId: string,
  encryptionKeys: string[],
  mediators: string[]
): { encryptionKeys: AssetEncryptionKey[]; mediators: AssetMediator[] } => ({
  encryptionKeys: [...new Set(encryptionKeys)].map(encryptionKeyId => ({
    id: `${assetId}/${encryptionKeyId}`,
    assetId,
    encryptionKeyId,
  })),
  mediators: [...new Set(mediators)].map(accountId => ({
    id: `${assetId}/${accountId}`,
    assetId,
    accountId,
  })),
});

/**
 * The rows an `AssetCreated` or `AssetUpdated` names. Mediators come as a map of confidential
 * account public key -> encryption public key, auditors as encryption keys.
 */
const assetKeyRowsOf = (assetId: string, rawMediators: Codec, rawAuditors: Codec) => {
  const mediators = (rawMediators.toJSON() ?? {}) as Record<string, string>;
  return confidentialAssetKeyRows(
    assetId,
    [...getStringArrayValue(rawAuditors), ...Object.values(mediators)],
    Object.keys(mediators)
  );
};

type AssetKeyEntity = 'ConfidentialAssetEncryptionKey' | 'ConfidentialAssetMediator';

const createAssetRows = (
  entity: AssetKeyEntity,
  rows: { id: string }[],
  blockEventId: string
): Promise<void> =>
  rows.length > 0
    ? store.bulkCreate(
        entity,
        rows.map(row => ({ ...row, createdEventId: blockEventId }))
      )
    : Promise.resolve();

/**
 * Makes the asset's rows of `entity` the ones given, from the `current` ones: removes those it no
 * longer names and adds the new ones, so a row the update keeps keeps the event that added it.
 */
const replaceAssetRows = async (
  entity: AssetKeyEntity,
  current: { id: string }[],
  rows: { id: string }[],
  blockEventId: string
): Promise<void> => {
  const kept = new Set(rows.map(({ id }) => id));
  const existing = new Set(current.map(({ id }) => id));
  const dropped = current.filter(({ id }) => !kept.has(id)).map(({ id }) => id);
  if (dropped.length > 0) {
    await store.bulkRemove(entity, dropped);
  }
  await createAssetRows(
    entity,
    rows.filter(({ id }) => !existing.has(id)),
    blockEventId
  );
};

export const handleConfidentialAssetCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockEventId } = extractArgs(event);

  const [rawDid, rawAssetId, rawMediators, rawAuditors, rawName, rawSymbol, rawDecimals, rawData] =
    params;

  const assetId = getTextValue(rawAssetId);

  await ConfidentialAsset.create({
    id: assetId,
    assetId: getNumberValue(rawAssetId),
    name: storedText(rawName),
    symbol: storedText(rawSymbol),
    decimals: getNumberValue(rawDecimals),
    data: storedText(rawData),
    creatorId: getTextValue(rawDid),
    totalSupply: BigInt(0),
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();

  const { encryptionKeys, mediators } = assetKeyRowsOf(assetId, rawMediators, rawAuditors);
  await createAssetRows('ConfidentialAssetEncryptionKey', encryptionKeys, blockEventId);
  await createAssetRows('ConfidentialAssetMediator', mediators, blockEventId);
};

export const handleConfidentialAssetUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockEventId } = extractArgs(event);

  const [, rawAssetId, rawMediators, rawAuditors] = params;

  const asset = await ConfidentialAsset.get(getTextValue(rawAssetId));

  if (asset) {
    const { encryptionKeys, mediators } = assetKeyRowsOf(asset.id, rawMediators, rawAuditors);
    const currentKeys = await getAllByFields<ConfidentialAssetEncryptionKey>(
      'ConfidentialAssetEncryptionKey',
      [['assetId', '=', asset.id]]
    );
    const currentMediators = await getAllByFields<ConfidentialAssetMediator>(
      'ConfidentialAssetMediator',
      [['assetId', '=', asset.id]]
    );
    await replaceAssetRows(
      'ConfidentialAssetEncryptionKey',
      currentKeys,
      encryptionKeys,
      blockEventId
    );
    await replaceAssetRows('ConfidentialAssetMediator', currentMediators, mediators, blockEventId);

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
