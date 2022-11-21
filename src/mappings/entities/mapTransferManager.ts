import { Codec } from '@polkadot/types/types';
import {
  EventIdEnum,
  ModuleIdEnum,
  StatOpTypeEnum,
  StatType,
  TransferCompliance,
  TransferComplianceTypeEnum,
  TransferManager,
  TransferRestrictionTypeEnum,
} from '../../types';
import { getExemptionsValue, getTransferManagerValue, serializeTicker } from '../util';
import { HandlerArgs } from './common';

const getTransferManageId = (
  ticker: string,
  { type, value }: Pick<TransferManager, 'type' | 'value'>
): string => `${ticker}/${type}/${value}`;

const getTransferManager = (
  ticker: string,
  restriction: Pick<TransferManager, 'type' | 'value'>
): Promise<TransferManager | undefined> =>
  TransferManager.get(getTransferManageId(ticker, restriction));

const handleTransferManagerAdded = async (blockId: string, params: Codec[]) => {
  const [, rawTicker, rawManager] = params;

  const ticker = serializeTicker(rawTicker);
  const { type, value } = getTransferManagerValue(rawManager);
  const id = `${ticker}/${type}/${value}`;
  const complianceType =
    type === TransferRestrictionTypeEnum.Percentage
      ? TransferComplianceTypeEnum.MaxInvestorOwnership
      : TransferComplianceTypeEnum.MaxInvestorCount;

  const promises = [
    TransferManager.create({
      id,
      assetId: ticker,
      type,
      value,
      exemptedEntities: [],
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save(),
    TransferCompliance.create({
      id,
      assetId: ticker,
      type: complianceType,
      statTypeId: `${ticker}/${type}`,
      value: null,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save(),
  ];

  if (complianceType === TransferComplianceTypeEnum.MaxInvestorOwnership) {
    promises.push(
      StatType.create({
        id: `${ticker}/Balance`,
        opType: StatOpTypeEnum.Balance,
        assetId: ticker,
        claimType: null,
        claimIssuerId: null,
        createdBlockId: blockId,
        updatedBlockId: blockId,
      }).save()
    );
  }

  await Promise.all(promises);
};

const handleTransferManagerRemoved = async (params: Codec[]) => {
  const [, rawTicker, rawManager] = params;

  const ticker = serializeTicker(rawTicker);
  const { type, value } = getTransferManagerValue(rawManager);
  const id = `${ticker}/${type}/${value}`;

  await Promise.all([TransferManager.remove(id), TransferCompliance.remove(id)]);
};

const handleExemptionsAdded = async (blockId: string, params: Codec[]): Promise<void> => {
  const [, rawTicker, rawAgentGroup, rawExemptions] = params;

  const ticker = serializeTicker(rawTicker);
  const transferManagerValue = getTransferManagerValue(rawAgentGroup);
  const parsedExemptions = getExemptionsValue(rawExemptions);

  const transferManager = await getTransferManager(ticker, transferManagerValue);

  if (transferManager) {
    transferManager.exemptedEntities = [
      ...new Set<string>([...parsedExemptions, ...transferManager.exemptedEntities]),
    ];
    transferManager.updatedBlockId = blockId;

    await transferManager.save();
  }
};

const handleExemptionsRemoved = async (blockId: string, params: Codec[]) => {
  const [, rawTicker, rawAgentGroup, rawExemptions] = params;

  const ticker = serializeTicker(rawTicker);
  const transferManagerValue = getTransferManagerValue(rawAgentGroup);
  const parsedExemptions = getExemptionsValue(rawExemptions);

  const transferManager = await getTransferManager(ticker, transferManagerValue);

  if (transferManager) {
    transferManager.exemptedEntities = transferManager.exemptedEntities.filter(
      e => !parsedExemptions.includes(e)
    );
    transferManager.updatedBlockId = blockId;

    await transferManager.save();
  }
};

export async function mapTransferManager({
  blockId,
  eventId,
  moduleId,
  params,
}: HandlerArgs): Promise<void> {
  if (moduleId === ModuleIdEnum.statistics) {
    if (eventId === EventIdEnum.TransferManagerAdded) {
      await handleTransferManagerAdded(blockId, params);
    }
    if (eventId === EventIdEnum.TransferManagerRemoved) {
      await handleTransferManagerRemoved(params);
    }
    if (eventId === EventIdEnum.ExemptionsAdded) {
      await handleExemptionsAdded(blockId, params);
    }
    if (eventId === EventIdEnum.ExemptionsRemoved) {
      await handleExemptionsRemoved(blockId, params);
    }
  }
}
