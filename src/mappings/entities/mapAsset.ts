import { Codec } from '@polkadot/types/types';
import { isHex } from '@polkadot/util';
import { SubstrateEvent } from '@subql/types';
import { Asset, AssetDocument, AssetHolder, EventIdEnum, Funding, ModuleIdEnum } from '../../types';
import {
  getBigIntValue,
  getBooleanValue,
  getDocValue,
  getNumberValue,
  getPortfolioValue,
  getSecurityIdentifiers,
  getTextValue,
  hexToString,
  removeNullChars,
  serializeTicker,
} from '../util';
import { HandlerArgs } from './common';

export const getAsset = async (ticker: string): Promise<Asset> => {
  const asset = await Asset.getByTicker(ticker);

  if (!asset) {
    throw new Error(`Asset with ticker ${ticker} was not found.`);
  }

  return asset;
};

export const getAssetHolder = async (
  ticker: string,
  did: string,
  blockId: string
): Promise<AssetHolder> => {
  const id = `${ticker}/${did}`;

  let assetHolder = await AssetHolder.get(id);

  if (!assetHolder) {
    assetHolder = AssetHolder.create({
      id,
      identityId: did,
      assetId: ticker,
      amount: BigInt(0),
      createdBlockId: blockId,
      updatedBlockId: blockId,
    });
    await assetHolder.save();
  }

  return assetHolder;
};

const handleAssetCreated = async (
  blockId: string,
  params: Codec[],
  eventIdx: number
): Promise<void> => {
  const [rawOwnerDid, rawTicker, divisible, rawType, , disableIu] = params;
  const ownerId = getTextValue(rawOwnerDid);
  const ticker = serializeTicker(rawTicker);
  const type = getTextValue(rawType);
  /**
   * Name isn't present on the event so we need to query storage.
   * See MESH-1808 on Jira for the status on including name in the event
   *
   * @note
   *   - For chain >= 5.0.0, asset.assetNames provides a hex value
   *   - For chain < 5.0.0, asset.assetNames provides name of the ticker in plain text. In case
   *       the name is not present, it return 12 bytes string containing TICKER value padded with \0 at the end.
   */
  const rawName = await api.query.asset.assetNames(rawTicker);
  const nameString = getTextValue(rawName);
  let name;
  if (isHex(nameString)) {
    name = hexToString(nameString);
  } else {
    name = removeNullChars(nameString);
  }

  await Asset.create({
    id: ticker,
    ticker,
    name,
    type,
    fundingRound: null,
    isDivisible: getBooleanValue(divisible),
    isFrozen: false,
    isUniquenessRequired: !getBooleanValue(disableIu),
    identifiers: [],
    ownerId,
    totalSupply: BigInt(0),
    totalTransfers: BigInt(0),
    isCompliancePaused: false,
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

const handleAssetRenamed = async (blockId: string, params: Codec[]): Promise<void> => {
  const [, rawTicker, rawName] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.name = getTextValue(rawName);
  asset.updatedBlockId = blockId;

  await asset.save();
};

const handleFundingRoundSet = async (blockId: string, params: Codec[]): Promise<void> => {
  const [, rawTicker, rawFundingRound] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.fundingRound = getTextValue(rawFundingRound);
  asset.updatedBlockId = blockId;

  await asset.save();
};

const handleDocumentAdded = async (blockId: string, params: Codec[]): Promise<void> => {
  const [, rawTicker, rawDocId, rawDoc] = params;

  const ticker = serializeTicker(rawTicker);
  const documentId = getNumberValue(rawDocId);
  const docDetails = getDocValue(rawDoc);

  const { id: assetId } = await getAsset(ticker);

  await AssetDocument.create({
    id: `${ticker}/${documentId}`,
    documentId,
    ...docDetails,
    assetId,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

const handleDocumentRemoved = async (params: Codec[]): Promise<void> => {
  const [, rawTicker, rawDocId] = params;

  const ticker = serializeTicker(rawTicker);
  const documentId = getNumberValue(rawDocId);

  await AssetDocument.remove(`${ticker}/${documentId}`);
};

const handleIdentifiersUpdated = async (blockId: string, params: Codec[]): Promise<void> => {
  const [, rawTicker, rawIdentifiers] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.identifiers = getSecurityIdentifiers(rawIdentifiers);
  asset.updatedBlockId = blockId;

  await asset.save();
};

const handleDivisibilityChanged = async (blockId: string, params: Codec[]): Promise<void> => {
  const [, rawTicker] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.isDivisible = true;
  asset.updatedBlockId = blockId;

  await asset.save();
};

const handleIssued = async (
  blockId: string,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> => {
  const [, rawTicker, , rawAmount, rawFundingRound, rawTotalFundingAmount] = params;

  const ticker = serializeTicker(rawTicker);
  const issuedAmount = getBigIntValue(rawAmount);

  const fundingRound = getTextValue(rawFundingRound);
  const totalFundingAmount = getBigIntValue(rawTotalFundingAmount);

  const asset = await getAsset(ticker);
  asset.totalSupply += issuedAmount;
  asset.updatedBlockId = blockId;

  const assetOwner = await getAssetHolder(ticker, asset.ownerId, blockId);
  assetOwner.amount += issuedAmount;
  assetOwner.updatedBlockId = blockId;

  const promises = [asset.save(), assetOwner.save()];
  if (fundingRound) {
    promises.push(
      Funding.create({
        id: `${blockId}/${event.idx}`,
        assetId: ticker,
        fundingRound,
        amount: issuedAmount,
        totalFundingAmount,
        datetime: event.block.timestamp,
        createdBlockId: blockId,
        updatedBlockId: blockId,
      }).save()
    );
  }

  await Promise.all(promises);
};

const handleRedeemed = async (blockId: string, params: Codec[]): Promise<void> => {
  const [, rawTicker, , rawAmount] = params;

  const ticker = serializeTicker(rawTicker);
  const issuedAmount = getBigIntValue(rawAmount);

  const asset = await getAsset(ticker);
  asset.totalSupply -= issuedAmount;
  asset.updatedBlockId = blockId;

  const assetOwner = await getAssetHolder(ticker, asset.ownerId, blockId);
  assetOwner.amount -= issuedAmount;
  assetOwner.updatedBlockId = blockId;

  await Promise.all([asset.save(), assetOwner.save()]);
};

const handleFrozen = async (blockId: string, params: Codec[], isFrozen: boolean): Promise<void> => {
  const [, rawTicker] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.isFrozen = isFrozen;
  asset.updatedBlockId = blockId;

  await asset.save();
};

const handleAssetOwnershipTransferred = async (blockId: string, params: Codec[]) => {
  const [to, rawTicker] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.ownerId = getTextValue(to);
  asset.updatedBlockId = blockId;

  await asset.save();
};

const handleAssetTransfer = async (blockId: string, params: Codec[]) => {
  const [, rawTicker, rawFromPortfolio, rawToPortfolio, rawAmount] = params;
  const { identityId: fromDid } = getPortfolioValue(rawFromPortfolio);
  const { identityId: toDid } = getPortfolioValue(rawToPortfolio);
  const transferAmount = getBigIntValue(rawAmount);
  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.totalTransfers += BigInt(1);
  asset.updatedBlockId = blockId;

  const [fromHolder, toHolder] = await Promise.all([
    getAssetHolder(ticker, fromDid, blockId),
    getAssetHolder(ticker, toDid, blockId),
  ]);

  fromHolder.amount = fromHolder.amount - transferAmount;
  fromHolder.updatedBlockId = blockId;
  toHolder.amount = toHolder.amount + transferAmount;
  toHolder.updatedBlockId = blockId;

  await Promise.all([asset.save(), fromHolder.save(), toHolder.save()]);
};

const handleAssetUpdateEvents = async (
  blockId: string,
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> => {
  if (eventId === EventIdEnum.AssetCreated) {
    await handleAssetCreated(blockId, params, event.idx);
  }
  if (eventId === EventIdEnum.AssetRenamed) {
    await handleAssetRenamed(blockId, params);
  }
  if (eventId === EventIdEnum.FundingRoundSet) {
    await handleFundingRoundSet(blockId, params);
  }
  if (eventId === EventIdEnum.IdentifiersUpdated) {
    await handleIdentifiersUpdated(blockId, params);
  }
  if (eventId === EventIdEnum.DivisibilityChanged) {
    await handleDivisibilityChanged(blockId, params);
  }
  if (eventId === EventIdEnum.AssetFrozen) {
    await handleFrozen(blockId, params, true);
  }
  if (eventId === EventIdEnum.AssetUnfrozen) {
    await handleFrozen(blockId, params, false);
  }
};

export async function mapAsset({
  blockId,
  eventId,
  moduleId,
  params,
  event,
}: HandlerArgs): Promise<void> {
  if (moduleId !== ModuleIdEnum.asset) {
    return;
  }
  if (eventId === EventIdEnum.DocumentAdded) {
    await handleDocumentAdded(blockId, params);
  }
  if (eventId === EventIdEnum.DocumentRemoved) {
    await handleDocumentRemoved(params);
  }
  if (eventId === EventIdEnum.Issued) {
    await handleIssued(blockId, params, event);
  }
  if (eventId === EventIdEnum.Redeemed) {
    await handleRedeemed(blockId, params);
  }
  if (eventId === EventIdEnum.AssetOwnershipTransferred) {
    await handleAssetOwnershipTransferred(blockId, params);
  }
  if (eventId === EventIdEnum.Transfer) {
    await handleAssetTransfer(blockId, params);
  }
  await handleAssetUpdateEvents(blockId, eventId, params, event);

  // Unhandled asset events - CustomAssetTypeRegistered, CustomAssetTypeRegistered, ExtensionRemoved, IsIssueable, TickerRegistered, TickerTransferred, TransferWithData
}
