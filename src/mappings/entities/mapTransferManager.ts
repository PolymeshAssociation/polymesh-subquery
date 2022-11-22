import { Codec } from '@polkadot/types/types';
import {
  EventIdEnum,
  ModuleIdEnum,
  StatOpTypeEnum,
  StatType,
  TransferCompliance,
  TransferComplianceExemption,
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

  let complianceType = TransferComplianceTypeEnum.MaxInvestorCount;
  let opType = StatOpTypeEnum.Count;
  if (type === TransferRestrictionTypeEnum.Percentage) {
    complianceType = TransferComplianceTypeEnum.MaxInvestorOwnership;
    opType = StatOpTypeEnum.Balance;
  }

  const promises = [];

  if (complianceType === TransferComplianceTypeEnum.MaxInvestorOwnership) {
    const statId = `${ticker}/Balance`;
    const stat = await StatType.get(statId);
    if (!stat) {
      promises.push(
        StatType.create({
          id: statId,
          opType: StatOpTypeEnum.Balance,
          assetId: ticker,
          claimType: null,
          claimIssuerId: null,
          createdBlockId: blockId,
          updatedBlockId: blockId,
        }).save()
      );
    }
  }

  promises.push(
    TransferManager.create({
      id,
      assetId: ticker,
      type,
      value,
      exemptedEntities: [],
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save()
  );

  promises.push(
    TransferCompliance.create({
      id,
      assetId: ticker,
      type: complianceType,
      statTypeId: `${ticker}/${opType}`,
      value: BigInt(value),
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save()
  );

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

  const opType =
    transferManager.type === TransferRestrictionTypeEnum.Percentage
      ? StatOpTypeEnum.Balance
      : StatOpTypeEnum.Count;

  const promises = [];

  if (transferManager) {
    transferManager.exemptedEntities = [
      ...new Set<string>([...parsedExemptions, ...transferManager.exemptedEntities]),
    ];
    transferManager.updatedBlockId = blockId;

    promises.push(transferManager.save());

    const exemptKey = {
      assetId: ticker,
      opType,
      claimType: null,
    };
    transferManager.exemptedEntities.forEach(entity => {
      const upsert = async () => {
        const exemptionId = `${ticker}/${opType}/null/${entity}`;
        let exemption = await TransferComplianceExemption.get(exemptionId);
        if (exemption) {
          exemption.updatedBlockId = blockId;
        } else {
          exemption = TransferComplianceExemption.create({
            id: exemptionId,
            ...exemptKey,
            exemptedEntityId: entity,
            createdBlockId: blockId,
            updatedBlockId: blockId,
          });
        }
        return exemption.save();
      };
      promises.push(upsert());
    });
  }
  await Promise.all(promises);
};

const handleExemptionsRemoved = async (blockId: string, params: Codec[]) => {
  const [, rawTicker, rawAgentGroup, rawExemptions] = params;

  const promises = [];

  const ticker = serializeTicker(rawTicker);
  const transferManagerValue = getTransferManagerValue(rawAgentGroup);
  const parsedExemptions = getExemptionsValue(rawExemptions);

  const transferManager = await getTransferManager(ticker, transferManagerValue);

  if (transferManager) {
    transferManager.exemptedEntities = transferManager.exemptedEntities.filter(
      e => !parsedExemptions.includes(e)
    );
    transferManager.updatedBlockId = blockId;

    promises.push(transferManager.save());
  }

  const transferComplianceExemptions = await TransferComplianceExemption.getByAssetId(ticker);

  transferComplianceExemptions
    .filter(({ exemptedEntityId }) => parsedExemptions.includes(exemptedEntityId))
    .forEach(({ id }) => promises.push(TransferComplianceExemption.remove(id)));

  await Promise.all(promises);
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
