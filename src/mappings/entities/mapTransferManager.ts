import { SubstrateEvent } from '@subql/types';
import { TransferManager } from '../../types';
import { getExemptionsValue, getTransferManagerValue, serializeTicker } from '../../utils';
import { extractArgs } from './common';

const getTransferManageId = (
  ticker: string,
  { type, value }: Pick<TransferManager, 'type' | 'value'>
): string => `${ticker}/${type}/${value}`;

const getTransferManager = (
  ticker: string,
  restriction: Pick<TransferManager, 'type' | 'value'>
): Promise<TransferManager | undefined> =>
  TransferManager.get(getTransferManageId(ticker, restriction));

export const handleTransferManagerAdded = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawTicker, rawManager] = params;

  const ticker = serializeTicker(rawTicker);
  const { type, value } = getTransferManagerValue(rawManager);
  const id = `${ticker}/${type}/${value}`;

  await TransferManager.create({
    id,
    assetId: ticker,
    type,
    value,
    exemptedEntities: [],
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const handleTransferManagerRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { params } = extractArgs(event);
  const [, rawTicker, rawManager] = params;

  const ticker = serializeTicker(rawTicker);
  const { type, value } = getTransferManagerValue(rawManager);
  const id = `${ticker}/${type}/${value}`;

  await TransferManager.remove(id);
};

export const handleExemptionsAdded = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
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

export const handleExemptionsRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
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
