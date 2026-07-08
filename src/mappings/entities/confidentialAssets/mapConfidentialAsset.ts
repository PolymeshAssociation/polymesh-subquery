import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { ConfidentialAccountAsset, ConfidentialAsset, MediatorKey } from '../../../types';
import {
  bytesToString,
  getBigIntValue,
  getNumberValue,
  getStringArrayValue,
  getTextValue,
} from '../../../utils';
import { extractArgs } from '../common';

/**
 * Mediators are emitted as a map of confidential account public key -> encryption public key
 */
export const getMediators = (item: Codec): MediatorKey[] => {
  const mediators = item.toJSON() as Record<string, string>;

  return Object.entries(mediators).map(([accountKey, encryptionKey]) => ({
    accountKey,
    encryptionKey,
  }));
};

export const handleConfidentialAssetCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);

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
    mediators: getMediators(rawMediators),
    auditors: getStringArrayValue(rawAuditors),
    totalSupply: BigInt(0),
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};

export const handleConfidentialAssetUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const [, rawAssetId, rawMediators, rawAuditors] = params;

  const asset = await ConfidentialAsset.get(getTextValue(rawAssetId));

  if (asset) {
    asset.mediators = getMediators(rawMediators);
    asset.auditors = getStringArrayValue(rawAuditors);
    asset.updatedBlockId = blockId;

    await asset.save();
  }
};

export const handleConfidentialAssetMinted = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const [, rawAssetId, , rawTotalSupply] = params;

  const asset = await ConfidentialAsset.get(getTextValue(rawAssetId));

  if (asset) {
    asset.totalSupply = getBigIntValue(rawTotalSupply);
    asset.updatedBlockId = blockId;

    await asset.save();
  }
};

export const handleConfidentialAccountAssetRegistered = async (
  event: SubstrateEvent
): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);

  const [, rawAccount, rawAssetId] = params;

  const accountId = getTextValue(rawAccount);
  const assetId = getTextValue(rawAssetId);

  await ConfidentialAccountAsset.create({
    id: `${assetId}/${accountId}`,
    accountId,
    assetId,
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};
