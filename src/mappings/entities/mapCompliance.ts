import { Codec } from '@polkadot/types-codec/types';
import { SubstrateEvent } from '@subql/types';
import { Compliance, TrustedClaimIssuer } from '../../types';
import {
  getComplianceValue,
  getComplianceValues,
  getNumberValue,
  getTextValue,
  serializeTicker,
} from '../../utils';
import { extractArgs, getAsset } from './common';

export const handleAssetCompliancePaused = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawTicker] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await await getAsset(ticker);
  asset.isCompliancePaused = true;
  asset.updatedBlockId = blockId;

  await asset.save();
};

export const handleAssetComplianceResumed = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawTicker] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await await getAsset(ticker);
  asset.isCompliancePaused = false;
  asset.updatedBlockId = blockId;

  await asset.save();
};

export const handleComplianceReset = async (event: SubstrateEvent): Promise<void> => {
  const { params } = extractArgs(event);
  const [, rawTicker] = params;

  const ticker = serializeTicker(rawTicker);

  const complianceRequirements = await Compliance.getByAssetId(ticker);

  await Promise.all(complianceRequirements.map(({ id }) => Compliance.remove(id)));
};

const createCompliance = (ticker: string, complianceId: number, data: any, blockId: string) =>
  Compliance.create({
    id: `${ticker}/${complianceId}`,
    complianceId,
    data,
    assetId: ticker,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();

export const handleComplianceCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawTicker, rawCompliance] = params;

  const ticker = serializeTicker(rawTicker);
  const { complianceId, data } = getComplianceValue(rawCompliance);

  await createCompliance(ticker, complianceId, data, blockId);
};

export const handleComplianceReplaced = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawTicker, rawCompliances] = params;

  const ticker = serializeTicker(rawTicker);

  const existingCompliances = await Compliance.getByAssetId(ticker);

  const compliances = getComplianceValues(rawCompliances);

  await Promise.all([
    ...existingCompliances.map(({ id }) => Compliance.remove(id)),
    ...compliances.map(({ complianceId, data }) =>
      createCompliance(ticker, complianceId, data, blockId)
    ),
  ]);
};

export const handleComplianceRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { params } = extractArgs(event);
  const [, rawTicker, rawId] = params;

  const ticker = serializeTicker(rawTicker);
  const complianceId = getNumberValue(rawId);

  await Compliance.remove(`${ticker}/${complianceId}`);
};

export const handleTrustedDefaultClaimIssuerAdded = async (
  event: SubstrateEvent
): Promise<void> => {
  const { params, eventIdx, blockId } = extractArgs(event);

  const ticker = serializeTicker(params[1]);
  const issuer = (params[2] as unknown as { issuer: Codec }).issuer.toString();

  await TrustedClaimIssuer.create({
    id: `${ticker}/${issuer}`,
    eventIdx,
    assetId: ticker,
    issuer,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const handleTrustedDefaultClaimIssuerRemoved = async (
  event: SubstrateEvent
): Promise<void> => {
  const { params } = extractArgs(event);

  const ticker = serializeTicker(params[1]);
  const issuer = getTextValue(params[2]);
  await TrustedClaimIssuer.remove(`${ticker}/${issuer}`);
};
