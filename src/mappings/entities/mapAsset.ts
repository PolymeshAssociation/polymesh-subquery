import BN from 'bn.js';
import { SubstrateExtrinsic } from '@subql/types';
import { ModuleIdEnum, CallIdEnum } from './common';
import { Asset } from '../../types';
import { formatAssetIdentifiers } from '../util';

const chainNumberMultiplier = new BN(1000000);

const getAsset = async (ticker: string) => {
  const asset = await Asset.getByTicker(ticker);
  if (!asset) throw new Error(`Asset with ticker ${ticker} was not found.`);
  return asset;
};

const handleCreateAsset = async (
  params: Record<string, any>,
  extrinsic: any,
) => {
  const {
    name,
    ticker,
    assetType: type,
    fundingRound,
    divisible,
    disableIu,
    identifiers,
  } = params;
  const ownerDid = extrinsic.events[1].event.data[0].toString();
  await Asset.create({
    id: ticker,
    ticker,
    name,
    type,
    fundingRound,
    isDivisible: divisible,
    isFrozen: false,
    isUniquenessRequired: !disableIu,
    documents: [],
    identifiers: formatAssetIdentifiers(identifiers),
    ownerDid,
    fullAgents: [ownerDid],
    holders: [],
    totalSupply: '0',
  }).save();
};

const handleRenameAsset = async (params: Record<string, any>) => {
  const { ticker, name: newName } = params;
  const asset = await getAsset(ticker);
  asset.name = newName;
  await asset.save();
};

const handleSetFundingRound = async (params: Record<string, any>) => {
  const { ticker, name: newFundingRound } = params;
  const asset = await getAsset(ticker);
  asset.fundingRound = newFundingRound;
  await asset.save();
};

type AssetNewDocument = {
  name: string;
  uri: string;
  content_hash?: any;
  doc_type?: string;
  filing_date?: Date;
};

const handleAddDocuments = async (
  params: Record<string, any>,
  extrinsic: any,
) => {
  const { ticker, docs } = params;
  const asset = await getAsset(ticker);
  asset.documents = docs.map((doc: AssetNewDocument, i: number) => ({
    id: Number(extrinsic.events[i].event.data[2].toString()),
    name: doc.name,
    link: doc.uri,
  }));
  await asset.save();
};

const handleRemoveDocuments = async (params: Record<string, any>) => {
  const { ticker, ids } = params;
  const asset = await getAsset(ticker);
  asset.documents = asset.documents.filter((doc) => !ids.includes(doc.id));
  await asset.save();
};

const handleUpdateIdentifiers = async (params: Record<string, any>) => {
  const { ticker, identifiers: newIdentifiers } = params;
  const asset = await getAsset(ticker);
  asset.identifiers = formatAssetIdentifiers(newIdentifiers);
  await asset.save();
};

const handleMakeDivisible = async (params: Record<string, any>) => {
  const { ticker } = params;
  const asset = await getAsset(ticker);
  asset.isDivisible = true;
  await asset.save();
};

const handleIssue = async (params: Record<string, any>) => {
  const { ticker, amount } = params;
  const asset = await getAsset(ticker);
  const formattedAmount = new BN(amount).div(chainNumberMultiplier);
  const newTotalSupply = new BN(asset.totalSupply).add(formattedAmount);
  const ownerAmount =
    new BN(asset.holders.find((h) => h.did === asset.ownerDid)?.amount) ||
    new BN(0);
  const ownerNewAmount = ownerAmount.add(formattedAmount);
  const otherHolders = asset.holders.filter((h) => h.did !== asset.ownerDid);
  asset.holders = [
    ...otherHolders,
    { did: asset.ownerDid, amount: ownerNewAmount.toString() },
  ];
  asset.totalSupply = newTotalSupply.toString();
  await asset.save();
};

const handleRedeem = async (params: Record<string, any>) => {
  const { ticker, value: amount } = params;
  const asset = await getAsset(ticker);
  const formattedAmount = new BN(amount).div(chainNumberMultiplier);
  const newTotalSupply = new BN(asset.totalSupply).sub(formattedAmount);
  const ownerAmount =
    new BN(asset.holders.find((h) => h.did === asset.ownerDid)?.amount) ||
    new BN(0);
  const ownerNewAmount = ownerAmount.sub(formattedAmount);
  const otherHolders = asset.holders.filter((h) => h.did !== asset.ownerDid);
  asset.holders = [
    ...otherHolders,
    ...(ownerNewAmount.gt(new BN(0))
      ? [{ did: asset.ownerDid, amount: ownerNewAmount.toString() }]
      : []),
  ];
  asset.totalSupply = newTotalSupply.toString();
  await asset.save();
};

const handleFreeze = async (params: Record<string, any>) => {
  const { ticker } = params;
  const asset = await getAsset(ticker);
  asset.isFrozen = true;
  await asset.save();
};

const handleUnfreeze = async (params: Record<string, any>) => {
  const { ticker } = params;
  const asset = await getAsset(ticker);
  asset.isFrozen = false;
  await asset.save();
};

export async function mapAsset(
  blockId: number,
  callId: CallIdEnum,
  moduleId: ModuleIdEnum,
  params: Record<string, any>,
  extrinsic: SubstrateExtrinsic,
): Promise<void> {
  if (!extrinsic.success || ![ModuleIdEnum.Asset].includes(moduleId)) {
    return;
  }

  if (callId === CallIdEnum.CreateAsset) {
    await handleCreateAsset(params, extrinsic);
  }

  if (callId === CallIdEnum.RenameAsset) {
    await handleRenameAsset(params);
  }

  if (callId === CallIdEnum.SetFundingRound) {
    await handleSetFundingRound(params);
  }

  if (callId === CallIdEnum.AddDocuments) {
    await handleAddDocuments(params, extrinsic);
  }

  if (callId === CallIdEnum.RemoveDocuments) {
    await handleRemoveDocuments(params);
  }

  if (callId === CallIdEnum.UpdateIdentifiers) {
    await handleUpdateIdentifiers(params);
  }

  if (callId === CallIdEnum.MakeDivisible) {
    await handleMakeDivisible(params);
  }

  if (callId === CallIdEnum.Issue) {
    await handleIssue(params);
  }

  if (callId === CallIdEnum.Redeem) {
    await handleRedeem(params);
  }

  if (callId === CallIdEnum.Freeze) {
    await handleFreeze(params);
  }

  if (callId === CallIdEnum.Unfreeze) {
    await handleUnfreeze(params);
  }
}
