import BN from 'bn.js';
import { SubstrateExtrinsic } from '@subql/types';
import { ModuleIdEnum, CallIdEnum } from './common';
import { Asset } from '../../types';

const chainNumberMultiplier = new BN(1000000);

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
    identifiers,
    ownerDid,
    fullAgents: [ownerDid],
    holders: [],
    totalSupply: '0',
  }).save();
};

const handleRenameAsset = async (params: Record<string, any>) => {
  const { ticker, name: newName } = params;
  const token = await Asset.getByTicker(ticker);
  if (!token) throw new Error(`Ticker ${ticker} was not found.`);
  token.name = newName;
  await token.save();
};

const handleSetFundingRound = async (params: Record<string, any>) => {
  const { ticker, name: newFundingRound } = params;
  const token = await Asset.getByTicker(ticker);
  if (!token) throw new Error(`Ticker ${ticker} was not found.`);
  token.fundingRound = newFundingRound;
  await token.save();
};

type NewAssetDocument = {
  name: string;
  uri: string;
  content_hash?: string;
  doc_type?: string;
  filing_date?: Date;
};

const handleAddDocuments = async (params: Record<string, any>) => {
  const { ticker, docs } = params;
  const token = await Asset.getByTicker(ticker);
  if (!token) throw new Error(`Ticker ${ticker} was not found.`);
  token.documents = docs.map((d: NewAssetDocument) => ({
    name: d.name,
    link: d.uri,
  }));
  await token.save();
};

const handleUpdateIdentifiers = async (params: Record<string, any>) => {
  const { ticker, identifiers: newIdentifiers } = params;
  const token = await Asset.getByTicker(ticker);
  if (!token) throw new Error(`Ticker ${ticker} was not found.`);
  token.identifiers = newIdentifiers;
  await token.save();
};

const handleMakeDivisible = async (params: Record<string, any>) => {
  const { ticker } = params;
  const token = await Asset.getByTicker(ticker);
  if (!token) throw new Error(`Ticker ${ticker} was not found.`);
  token.isDivisible = true;
  await token.save();
};

const handleIssue = async (params: Record<string, any>) => {
  const { ticker, amount } = params;
  const token = await Asset.getByTicker(ticker);
  if (!token) throw new Error(`Ticker ${ticker} was not found.`);
  const formattedAmount = new BN(amount).div(chainNumberMultiplier);
  const newTotalSupply = new BN(token.totalSupply).add(formattedAmount);
  const ownerAmount =
    new BN(token.holders.find((h) => h.did === token.ownerDid)?.amount) ||
    new BN(0);
  const ownerNewAmount = ownerAmount.add(formattedAmount);
  const otherHolders = token.holders.filter((h) => h.did !== token.ownerDid);
  token.holders = [
    ...otherHolders,
    { did: token.ownerDid, amount: ownerNewAmount.toString() },
  ];
  token.totalSupply = newTotalSupply.toString();
  await token.save();
};

const handleRedeem = async (params: Record<string, any>) => {
  const { ticker, value: amount } = params;
  const token = await Asset.getByTicker(ticker);
  if (!token) throw new Error(`Ticker ${ticker} was not found.`);
  const formattedAmount = new BN(amount).div(chainNumberMultiplier);
  const newTotalSupply = new BN(token.totalSupply).sub(formattedAmount);
  const ownerAmount =
    new BN(token.holders.find((h) => h.did === token.ownerDid)?.amount) ||
    new BN(0);
  const ownerNewAmount = ownerAmount.sub(formattedAmount);
  const otherHolders = token.holders.filter((h) => h.did !== token.ownerDid);
  token.holders = [
    ...otherHolders,
    ...(ownerNewAmount.gt(new BN(0))
      ? [{ did: token.ownerDid, amount: ownerNewAmount.toString() }]
      : []),
  ];
  token.totalSupply = newTotalSupply.toString();
  await token.save();
};

const handleFreeze = async (params: Record<string, any>) => {
  const { ticker } = params;
  const token = await Asset.getByTicker(ticker);
  if (!token) throw new Error(`Ticker ${ticker} was not found.`);
  token.isFrozen = true;
  await token.save();
};

const handleUnfreeze = async (params: Record<string, any>) => {
  const { ticker } = params;
  const token = await Asset.getByTicker(ticker);
  if (!token) throw new Error(`Ticker ${ticker} was not found.`);
  token.isFrozen = false;
  await token.save();
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
    await handleAddDocuments(params);
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
