import { Codec } from '@polkadot/types/types';
import { Compliance, EventIdEnum, ModuleIdEnum } from '../../types';
import { getComplianceValue, getNumberValue, serializeTicker } from '../util';
import { HandlerArgs } from './common';
import { getAsset } from './mapAsset';

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

const handleComplianceCreated = async (blockId: string, params: Codec[]) => {
  const [, rawTicker, rawCompliance] = params;

  const ticker = serializeTicker(rawTicker);
  const { complianceId, data } = getComplianceValue(rawCompliance);

  await Compliance.create({
    id: `${ticker}/${complianceId}`,
    complianceId,
    data,
    assetId: ticker,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
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
      await Promise.all([handleComplianceReset(params), handleComplianceCreated(blockId, params)]);
    }
    if (eventId === EventIdEnum.ComplianceRequirementCreated) {
      await handleComplianceCreated(blockId, params);
    }
    if (eventId === EventIdEnum.ComplianceRequirementRemoved) {
      await handleComplianceRemoved(params);
    }
  }
}
