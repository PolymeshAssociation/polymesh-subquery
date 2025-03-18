import { Codec } from '@polkadot/types-codec/types';
import { SubstrateEvent } from '@subql/types';
import { Compliance, TrustedClaimIssuer } from '../../../types';
import {
  getAssetId,
  getComplianceValue,
  getComplianceValues,
  getNumberValue,
  getPaginatedData,
  getTextValue,
} from '../../../utils';
import { extractArgs, getAsset } from '../common';

export const handleAssetCompliancePaused = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block } = extractArgs(event);
  const [, rawAssetId] = params;

  const assetId = await getAssetId(rawAssetId, block);

  const asset = await getAsset(assetId);
  asset.isCompliancePaused = true;
  asset.updatedBlockId = blockId;

  await asset.save();
};

export const handleAssetComplianceResumed = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block } = extractArgs(event);
  const [, rawAssetId] = params;

  const assetId = await getAssetId(rawAssetId, block);

  const asset = await getAsset(assetId);
  asset.isCompliancePaused = false;
  asset.updatedBlockId = blockId;

  await asset.save();
};

export const handleComplianceReset = async (event: SubstrateEvent): Promise<void> => {
  const { params, block } = extractArgs(event);
  const [, rawAssetId] = params;

  const assetId = await getAssetId(rawAssetId, block);

  const compliances = await getPaginatedData(Compliance.getByAssetId, assetId, 'assetId');

  await store.bulkRemove(
    'Compliance',
    compliances.map(({ id }) => id)
  );
};

const createCompliance = (assetId: string, complianceId: number, data: any, blockId: string) =>
  Compliance.create({
    id: `${assetId}/${complianceId}`,
    complianceId,
    data,
    assetId,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();

export const handleComplianceCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block } = extractArgs(event);
  const [, rawAssetId, rawCompliance] = params;

  const assetId = await getAssetId(rawAssetId, block);
  const { complianceId, data } = getComplianceValue(rawCompliance);

  await createCompliance(assetId, complianceId, data, blockId);
};

export const handleComplianceReplaced = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block } = extractArgs(event);
  const [, rawAssetId, rawCompliances] = params;

  const assetId = await getAssetId(rawAssetId, block);

  const compliances = getComplianceValues(rawCompliances);

  const compliancesToRemove = await getPaginatedData(Compliance.getByAssetId, assetId, 'assetId');
  await Promise.all([
    store.bulkRemove(
      'Compliance',
      compliancesToRemove.map(({ id }) => id)
    ),
    store.bulkCreate(
      'Compliance',
      compliances.map(({ complianceId, data }) => ({
        id: `${assetId}/${complianceId}`,
        complianceId,
        data,
        assetId,
        createdBlockId: blockId,
        updatedBlockId: blockId,
      }))
    ),
  ]);
};

export const handleComplianceRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { params, block } = extractArgs(event);
  const [, rawAssetId, rawId] = params;

  const assetId = await getAssetId(rawAssetId, block);
  const complianceId = getNumberValue(rawId);

  await Compliance.remove(`${assetId}/${complianceId}`);
};

export const handleTrustedDefaultClaimIssuerAdded = async (
  event: SubstrateEvent
): Promise<void> => {
  const { params, eventIdx, blockId, block, blockEventId } = extractArgs(event);

  const [, rawAssetId, rawIssuer] = params;
  const assetId = await getAssetId(rawAssetId, block);
  const issuer = (rawIssuer as unknown as { issuer: Codec }).issuer.toString();

  await TrustedClaimIssuer.create({
    id: `${assetId}/${issuer}`,
    eventIdx,
    assetId,
    issuer,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};

export const handleTrustedDefaultClaimIssuerRemoved = async (
  event: SubstrateEvent
): Promise<void> => {
  const { params, block } = extractArgs(event);

  const [, rawAssetId, rawIdentity] = params;
  const assetId = await getAssetId(rawAssetId, block);
  const issuer = getTextValue(rawIdentity);
  await TrustedClaimIssuer.remove(`${assetId}/${issuer}`);
};
