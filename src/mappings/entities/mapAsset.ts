import { Codec } from '@polkadot/types/types';
import { AssetDocument } from 'polymesh-subql/types/models/AssetDocument';
import { Asset, AssetHolder } from '../../types';
import {
  getBigIntValue,
  getBooleanValue,
  getDocValue,
  getNumberValue,
  getSecurityIdentifiers,
  getTextValue,
  serializeTicker,
} from '../util';
import { EventIdEnum, ModuleIdEnum } from './common';

const chainAmountToBigInt = (amount: bigint): bigint => amount / BigInt(1000000);

export const getAsset = async (ticker: string): Promise<Asset> => {
  const asset = await Asset.getByTicker(ticker);

  if (!asset) {
    throw new Error(`Asset with ticker ${ticker} was not found.`);
  }

  return asset;
};

export const getAssetHolder = async (ticker: string, did: string): Promise<AssetHolder> => {
  const id = `${ticker}/${did}`;

  let assetHolder = await AssetHolder.get(id);

  if (!assetHolder) {
    assetHolder = AssetHolder.create({
      id,
      did,
      assetId: ticker,
      amount: BigInt(0),
    });
    await assetHolder.save();
  }

  return assetHolder;
};

const handleAssetCreated = async (params: Codec[]): Promise<void> => {
  const [rawOwnerDid, rawTicker, divisible, rawType, , disableIu] = params;
  const ownerDid = getTextValue(rawOwnerDid);
  const ticker = serializeTicker(rawTicker);
  const type = getTextValue(rawType);
  // Name isn't present on the event so we need to query storage
  // See MESH-1808 on Jira for the status on including name in the event
  const rawName = await api.query.asset.assetNames(rawTicker);
  const name = getTextValue(rawName);

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
    ownerDid,
    totalSupply: BigInt(0),
    totalTransfers: BigInt(0),
    isCompliancePaused: false,
  }).save();
};

const handleAssetRenamed = async (params: Codec[]): Promise<void> => {
  const [, rawTicker, rawName] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.name = getTextValue(rawName);

  await asset.save();
};

const handleFundingRoundSet = async (params: Codec[]): Promise<void> => {
  const [, rawTicker, rawFundingRound] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.fundingRound = getTextValue(rawFundingRound);

  await asset.save();
};

const handleDocumentAdded = async (params: Codec[]): Promise<void> => {
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
  }).save();
};

const handleDocumentRemoved = async (params: Codec[]): Promise<void> => {
  const [, rawTicker, rawDocId] = params;

  const ticker = serializeTicker(rawTicker);
  const documentId = getNumberValue(rawDocId);

  await AssetDocument.remove(`${ticker}/${documentId}`);
};

const handleIdentifiersUpdated = async (params: Codec[]): Promise<void> => {
  const [, rawTicker, rawIdentifiers] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.identifiers = getSecurityIdentifiers(rawIdentifiers);

  await asset.save();
};

const handleDivisibilityChanged = async (params: Codec[]): Promise<void> => {
  const [, rawTicker] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.isDivisible = true;

  await asset.save();
};

const handleIssued = async (params: Codec[]): Promise<void> => {
  const [, rawTicker, , rawAmount] = params;

  const ticker = serializeTicker(rawTicker);
  const issuedAmount = chainAmountToBigInt(getBigIntValue(rawAmount));

  const asset = await getAsset(ticker);
  asset.totalSupply += issuedAmount;

  const assetOwner = await getAssetHolder(asset.ownerDid, ticker);
  assetOwner.amount += issuedAmount;

  await Promise.all([asset.save(), assetOwner.save()]);
};

const handleRedeemed = async (params: Codec[]): Promise<void> => {
  const [, rawTicker, , rawAmount] = params;

  const ticker = serializeTicker(rawTicker);
  const issuedAmount = chainAmountToBigInt(getBigIntValue(rawAmount));

  const asset = await getAsset(ticker);
  asset.totalSupply -= issuedAmount;

  const assetOwner = await getAssetHolder(asset.ownerDid, ticker);
  assetOwner.amount -= issuedAmount;

  await Promise.all([asset.save(), assetOwner.save()]);
  await Promise.all([asset.save(), assetOwner.save()]);
};

const handleFrozen = async (params: Codec[], isFrozen: boolean): Promise<void> => {
  const [, rawTicker] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.isFrozen = isFrozen;

  await asset.save();
};

const handleAssetOwnershipTransferred = async (params: Codec[]) => {
  const [to, rawTicker] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.ownerDid = getTextValue(to);

  await asset.save();
};

export async function mapAsset(
  eventId: EventIdEnum,
  moduleId: ModuleIdEnum,
  params: Codec[]
): Promise<void> {
  if (moduleId !== ModuleIdEnum.Asset) {
    return;
  }
  if (eventId === EventIdEnum.AssetCreated) {
    await handleAssetCreated(params);
  }
  if (eventId === EventIdEnum.AssetRenamed) {
    await handleAssetRenamed(params);
  }
  if (eventId === EventIdEnum.FundingRoundSet) {
    await handleFundingRoundSet(params);
  }
  if (eventId === EventIdEnum.DocumentAdded) {
    await handleDocumentAdded(params);
  }
  if (eventId === EventIdEnum.DocumentRemoved) {
    await handleDocumentRemoved(params);
  }
  if (eventId === EventIdEnum.IdentifiersUpdated) {
    await handleIdentifiersUpdated(params);
  }
  if (eventId === EventIdEnum.DivisibilityChanged) {
    await handleDivisibilityChanged(params);
  }
  if (eventId === EventIdEnum.Issued) {
    await handleIssued(params);
  }
  if (eventId === EventIdEnum.Redeemed) {
    await handleRedeemed(params);
  }
  if (eventId === EventIdEnum.Frozen) {
    await handleFrozen(params, true);
  }
  if (eventId === EventIdEnum.Unfrozen) {
    await handleFrozen(params, false);
  }
  if (eventId === EventIdEnum.AssetOwnershipTransferred) {
    await handleAssetOwnershipTransferred(params);
  }
}
