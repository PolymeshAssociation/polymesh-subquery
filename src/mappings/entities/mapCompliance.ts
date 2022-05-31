import { Codec } from '@polkadot/types/types';
import { Compliance } from '../../types';
import { getComplianceValue, getNumberValue, serializeTicker } from '../util';
import { EventIdEnum, ModuleIdEnum } from './common';
import { getAsset } from './mapAsset';

const handleAssetComplianceState = async (params: Codec[], isPaused: boolean) => {
  const [, rawTicker] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.isCompliancePaused = isPaused;

  await asset.save();
};

const handleComplianceReset = async (params: Codec[]) => {
  const [, rawTicker] = params;

  const ticker = serializeTicker(rawTicker);

  const complianceRequirements = await Compliance.getByAssetId(ticker);

  await Promise.all(complianceRequirements.map(({ id }) => Compliance.remove(id)));
};

const handleComplianceCreated = async (params: Codec[]) => {
  const [, rawTicker, rawCompliance] = params;

  const ticker = serializeTicker(rawTicker);
  const { complianceId, data } = getComplianceValue(rawCompliance);

  await Compliance.create({
    id: `${ticker}/${complianceId}`,
    complianceId,
    data,
    assetId: ticker,
  }).save();
};

const handleComplianceRemoved = async (params: Codec[]) => {
  const [, rawTicker, rawId] = params;

  const ticker = serializeTicker(rawTicker);
  const complianceId = getNumberValue(rawId);

  await Compliance.remove(`${ticker}/${complianceId}`);
};

export async function mapCompliance(
  eventId: EventIdEnum,
  moduleId: ModuleIdEnum,
  params: Codec[]
): Promise<void> {
  if (moduleId === ModuleIdEnum.Compliancemanager) {
    if (eventId === EventIdEnum.AssetCompliancePaused) {
      await handleAssetComplianceState(params, true);
    }
    if (eventId === EventIdEnum.AssetComplianceResumed) {
      await handleAssetComplianceState(params, false);
    }
    if (eventId === EventIdEnum.AssetComplianceReset) {
      await handleComplianceReset(params);
    }
    if (eventId === EventIdEnum.AssetComplianceReplaced) {
      await Promise.all([handleComplianceReset(params), handleComplianceCreated(params)]);
    }
    if (eventId === EventIdEnum.ComplianceRequirementCreated) {
      await handleComplianceCreated(params);
    }
    if (eventId === EventIdEnum.ComplianceRequirementRemoved) {
      await handleComplianceRemoved(params);
    }
  }
}
