import { Codec } from '@polkadot/types/types';
import { Compliance, EventIdEnum, ModuleIdEnum } from '../../types';
import { getComplianceValue, getComplianceValues, getNumberValue, serializeTicker } from '../util';
import { HandlerArgs, getAsset } from './common';

const handleAssetComplianceState = async (blockId: string, params: Codec[], isPaused: boolean) => {
  const [, rawTicker] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.isCompliancePaused = isPaused;
  asset.updatedBlockId = blockId;

  await asset.save();
};

const handleComplianceReset = async (params: Codec[]) => {
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

const handleComplianceCreated = async (blockId: string, params: Codec[]) => {
  const [, rawTicker, rawCompliance] = params;

  const ticker = serializeTicker(rawTicker);
  const { complianceId, data } = getComplianceValue(rawCompliance);

  await createCompliance(ticker, complianceId, data, blockId);
};

const handleComplianceReplaced = async (blockId: string, params: Codec[]) => {
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

const handleComplianceRemoved = async (params: Codec[]) => {
  const [, rawTicker, rawId] = params;

  const ticker = serializeTicker(rawTicker);
  const complianceId = getNumberValue(rawId);

  await Compliance.remove(`${ticker}/${complianceId}`);
};

export async function mapCompliance({
  blockId,
  eventId,
  moduleId,
  params,
}: HandlerArgs): Promise<void> {
  if (moduleId === ModuleIdEnum.compliancemanager) {
    if (eventId === EventIdEnum.AssetCompliancePaused) {
      await handleAssetComplianceState(blockId, params, true);
    }
    if (eventId === EventIdEnum.AssetComplianceResumed) {
      await handleAssetComplianceState(blockId, params, false);
    }
    if (eventId === EventIdEnum.AssetComplianceReset) {
      await handleComplianceReset(params);
    }
    if (eventId === EventIdEnum.AssetComplianceReplaced) {
      await handleComplianceReplaced(blockId, params);
    }
    if (eventId === EventIdEnum.ComplianceRequirementCreated) {
      await handleComplianceCreated(blockId, params);
    }
    if (eventId === EventIdEnum.ComplianceRequirementRemoved) {
      await handleComplianceRemoved(params);
    }
  }
}
