import { SubstrateEvent } from '@subql/types';
import { TransferManager } from '../../types';
import { getAssetId, getExemptionsValue, getTransferManagerValue } from '../../utils';
import { extractArgs } from './common';

const getTransferManageId = (
  assetId: string,
  { type, value }: Pick<TransferManager, 'type' | 'value'>
): string => `${assetId}/${type}/${value}`;

const getTransferManager = (
  assetId: string,
  restriction: Pick<TransferManager, 'type' | 'value'>
): Promise<TransferManager | undefined> =>
  TransferManager.get(getTransferManageId(assetId, restriction));

export const handleTransferManagerAdded = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block } = extractArgs(event);
  const [, rawAssetId, rawManager] = params;

  const assetId = getAssetId(rawAssetId, block);
  const { type, value } = getTransferManagerValue(rawManager);
  const id = `${assetId}/${type}/${value}`;

  await TransferManager.create({
    id,
    assetId,
    type,
    value,
    exemptedEntities: [],
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const handleTransferManagerRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { params, block } = extractArgs(event);
  const [, rawAssetId, rawManager] = params;

  const assetId = getAssetId(rawAssetId, block);
  const { type, value } = getTransferManagerValue(rawManager);
  const id = `${assetId}/${type}/${value}`;

  await TransferManager.remove(id);
};

export const handleExemptionsAdded = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block } = extractArgs(event);
  const [, rawAssetId, rawAgentGroup, rawExemptions] = params;

  const assetId = getAssetId(rawAssetId, block);
  const transferManagerValue = getTransferManagerValue(rawAgentGroup);
  const parsedExemptions = getExemptionsValue(rawExemptions);

  const transferManager = await getTransferManager(assetId, transferManagerValue);

  if (transferManager) {
    transferManager.exemptedEntities = [
      ...new Set<string>([...parsedExemptions, ...transferManager.exemptedEntities]),
    ];
    transferManager.updatedBlockId = blockId;

    await transferManager.save();
  }
};

export const handleExemptionsRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block } = extractArgs(event);
  const [, rawAssetId, rawAgentGroup, rawExemptions] = params;

  const assetId = getAssetId(rawAssetId, block);
  const transferManagerValue = getTransferManagerValue(rawAgentGroup);
  const parsedExemptions = getExemptionsValue(rawExemptions);

  const transferManager = await getTransferManager(assetId, transferManagerValue);

  if (transferManager) {
    transferManager.exemptedEntities = transferManager.exemptedEntities.filter(
      e => !parsedExemptions.includes(e)
    );
    transferManager.updatedBlockId = blockId;

    await transferManager.save();
  }
};
