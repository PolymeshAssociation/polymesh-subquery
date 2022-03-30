import BigNumber from 'bignumber.js';
import { SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import { ModuleIdEnum, CallIdEnum, AuthorizationTypeEnum, EventIdEnum } from './common';
import {
  Asset,
  AssetHolder,
  AssetPendingOwnershipTransfer,
  AssetAdvancedCompliance,
} from '../../types';
import { formatAssetIdentifiers } from '../util';

// #region Utils
const chainAmountToBigNumber = (amount: number): BigNumber =>
  new BigNumber(amount).div(new BigNumber(1000000));

export const getAsset = async (ticker: string): Promise<Asset> => {
  const asset = await Asset.getByTicker(ticker);
  if (!asset) throw new Error(`Asset with ticker ${ticker} was not found.`);
  return asset;
};

const getAuthorization = async (id: string) => {
  const authorization = await AssetPendingOwnershipTransfer.get(id);
  if (!authorization) throw new Error(`Authorization with id ${id} was not found.`);
  return authorization;
};

const getComplianceConditions = (conditions: any[], extrinsic: any) =>
  conditions.map((c: any) => ({
    id: Number(extrinsic.events[0].event.data[2].id.toString()),
    data: JSON.stringify(c),
  }));

const getTargetTransferManager = (
  manager: AssetAdvancedCompliance,
  managers: AssetAdvancedCompliance[]
) =>
  managers.find(
    e =>
      e.CountTransferManager === manager.CountTransferManager &&
      e.PercentageTransferManager === manager.PercentageTransferManager
  );

const excludeTransferManager = (
  manager: AssetAdvancedCompliance,
  managers: AssetAdvancedCompliance[]
) =>
  managers.filter(
    e =>
      e.CountTransferManager !== manager.CountTransferManager ||
      e.PercentageTransferManager !== manager.PercentageTransferManager
  );

export const getAssetHolder = async (did: string, asset: Asset): Promise<AssetHolder> => {
  const { ticker } = asset;
  const id = `${did}:${ticker}`;
  let assetHolder = await AssetHolder.get(id);
  if (!assetHolder) {
    assetHolder = AssetHolder.create({
      id,
      did,
      ticker,
      amount: '0',
      assetId: asset.id,
    });
    await assetHolder.save();
  }
  return assetHolder;
};
// #endregion

// #region ModuleIdEnum.Asset
const handleCreateAsset = async (params: Record<string, any>, extrinsic: any) => {
  const { name, ticker, assetType: type, fundingRound, divisible, disableIu, identifiers } = params;
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
    totalSupply: '0',
    totalTransfers: '0',
    compliance: { isPaused: false, sender: [], receiver: [], advanced: [] },
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

const handleAddDocuments = async (params: Record<string, any>, extrinsic: any) => {
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
  asset.documents = asset.documents.filter(doc => !ids.includes(doc.id));
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
  const assetOwner = await getAssetHolder(asset.ownerDid, asset);
  const formattedAmount = chainAmountToBigNumber(amount);
  assetOwner.amount = new BigNumber(assetOwner.amount).plus(formattedAmount).toString();
  asset.totalSupply = new BigNumber(asset.totalSupply).plus(formattedAmount).toString();
  await Promise.all([asset.save(), assetOwner.save()]);
};

const handleRedeem = async (params: Record<string, any>) => {
  const { ticker, value: amount } = params;
  const asset = await getAsset(ticker);
  const assetOwner = await getAssetHolder(asset.ownerDid, asset);
  const formattedAmount = chainAmountToBigNumber(amount);
  assetOwner.amount = new BigNumber(assetOwner.amount).minus(formattedAmount).toString();
  asset.totalSupply = new BigNumber(asset.totalSupply).minus(formattedAmount).toString();
  await Promise.all([asset.save(), assetOwner.save()]);
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

const handleAcceptAssetOwnershipTransfer = async (params: Record<string, any>) => {
  const { authId } = params;
  const authorization = await getAuthorization(authId);
  if (!authorization.ticker) return;
  const asset = await getAsset(authorization.ticker);
  asset.ownerDid = authorization.to;
  await asset.save();
  await AssetPendingOwnershipTransfer.remove(authId);
};
// #endregion

// #region ModuleIdEnum.Identity
const handleAddPendingOwnership = async (params: Record<string, any>, extrinsic: any) => {
  const { target: targetData, data: auth, authorizationData: legacyAuth } = params;

  const authData = auth || legacyAuth;
  const type = Object.keys(authData)[0] as AuthorizationTypeEnum;
  if (type === AuthorizationTypeEnum.TransferAssetOwnership) {
    const id = extrinsic.events[0].event.data[3].toString();
    let ticker: string;
    const from = extrinsic.events[0].event.data[0].toString();
    const to = targetData.Identity.toString();
    let data: string;
    if (type === AuthorizationTypeEnum.TransferAssetOwnership) {
      ticker = authData[type].toString();
    }
    await AssetPendingOwnershipTransfer.create({
      id,
      ticker,
      from,
      to,
      type,
      data,
    }).save();
  }
};

const handleRemovePendingOwnership = async (params: Record<string, any>) => {
  const { authId } = params;
  await AssetPendingOwnershipTransfer.remove(authId);
};
// #endregion

// #region ModuleIdEnum.Compliancemanager
const handlePauseAssetCompliance = async (params: Record<string, any>) => {
  const { ticker } = params;
  const asset = await getAsset(ticker);
  asset.compliance.isPaused = true;
  await asset.save();
};

const handleResumeAssetCompliance = async (params: Record<string, any>) => {
  const { ticker } = params;
  const asset = await getAsset(ticker);
  asset.compliance.isPaused = false;
  await asset.save();
};

const handleResetAssetCompliance = async (params: Record<string, any>) => {
  const { ticker } = params;
  const asset = await getAsset(ticker);
  asset.compliance.sender = [];
  asset.compliance.receiver = [];
  await asset.save();
};

const handleAddComplianceRequirement = async (params: Record<string, any>, extrinsic: any) => {
  const { ticker, senderConditions, receiverConditions } = params;
  const newSenderConditions = getComplianceConditions(senderConditions, extrinsic);
  const newReceiverConditions = getComplianceConditions(receiverConditions, extrinsic);
  const asset = await getAsset(ticker);
  asset.compliance.sender = [...asset.compliance.sender, ...newSenderConditions];
  asset.compliance.receiver = [...asset.compliance.receiver, ...newReceiverConditions];
  await asset.save();
};

const handleRemoveComplianceRequirement = async (params: Record<string, any>) => {
  const { ticker, id } = params;
  const asset = await getAsset(ticker);
  asset.compliance.sender = asset.compliance.sender.filter(s => s.id !== id);
  asset.compliance.receiver = asset.compliance.receiver.filter(s => s.id !== id);
  await asset.save();
};
// #endregion

// #region ModuleIdEnum.Externalagents
const handleAddTransferManager = async (params: Record<string, any>) => {
  const { ticker, newTransferManager } = params;
  const asset = await getAsset(ticker);
  asset.compliance.advanced = [...asset.compliance.advanced, newTransferManager];
  await asset.save();
};

const handleRemoveTransferManager = async (params: Record<string, any>) => {
  const { ticker, transferManager } = params;
  const asset = await getAsset(ticker);
  asset.compliance.advanced = excludeTransferManager(transferManager, asset.compliance.advanced);
  await asset.save();
};

const handleAddExemptedEntities = async (params: Record<string, any>) => {
  const { ticker, transferManager } = params;
  const asset = await getAsset(ticker);
  const targetTransferManager = getTargetTransferManager(
    transferManager,
    asset.compliance.advanced
  );
  if (!targetTransferManager) return;
  targetTransferManager.ExemptedEntities = [
    ...new Set<string>([
      ...(targetTransferManager.ExemptedEntities || []),
      ...(transferManager.exemptedEntities || []),
    ]),
  ];
  const otherTransferManagers = excludeTransferManager(transferManager, asset.compliance.advanced);
  asset.compliance.advanced = [...otherTransferManagers, targetTransferManager];
  await asset.save();
};

const handleRemoveExemptedEntities = async (params: Record<string, any>) => {
  const { ticker, transferManager } = params;
  const asset = await getAsset(ticker);
  const targetTransferManager = getTargetTransferManager(
    transferManager,
    asset.compliance.advanced
  );
  if (!targetTransferManager) return;
  targetTransferManager.ExemptedEntities = (targetTransferManager.ExemptedEntities || []).filter(
    e => !transferManager.exemptedEntities.includes(e)
  );
  const otherTransferManagers = excludeTransferManager(transferManager, asset.compliance.advanced);
  asset.compliance.advanced = [...otherTransferManagers, targetTransferManager];
  await asset.save();
};
// #endregion

const handleAsset = async (eventId: EventIdEnum, params: Record<string, any>, extrinsic: any) => {
  if (eventId === EventIdEnum.AssetCreated) {
    await handleCreateAsset(params, extrinsic);
  }
  if (eventId === EventIdEnum.AssetCreated) {
    await handleRenameAsset(params);
  }
  if (eventId === EventIdEnum.FundingRoundSet) {
    await handleSetFundingRound(params);
  }
  if (eventId === EventIdEnum.DocumentAdded) {
    await handleAddDocuments(params, extrinsic);
  }
  if (eventId === EventIdEnum.DocumentRemoved) {
    await handleRemoveDocuments(params);
  }
  if (eventId === EventIdEnum.IdentifiersUpdated) {
    await handleUpdateIdentifiers(params);
  }
  if (eventId === EventIdEnum.DivisibilityChanged) {
    await handleMakeDivisible(params);
  }
  if (eventId === EventIdEnum.Issued) {
    await handleIssue(params);
  }
  if (eventId === EventIdEnum.Redeemed) {
    await handleRedeem(params);
  }
  if (eventId === EventIdEnum.Frozen) {
    await handleFreeze(params);
  }
  if (eventId === EventIdEnum.Unfrozen) {
    await handleUnfreeze(params);
  }
  if (eventId === EventIdEnum.AssetOwnershipTransferred) {
    await handleAcceptAssetOwnershipTransfer(params);
  }
};

const handleIdentity = async (
  eventId: EventIdEnum,
  params: Record<string, any>,
  extrinsic: any
) => {
  if (eventId === EventIdEnum.AuthorizationAdded) {
    await handleAddPendingOwnership(params, extrinsic);
  }
  if (eventId === EventIdEnum.AuthorizationRejected) {
    await handleRemovePendingOwnership(params);
  }
};

const handleComplianceManager = async (
  eventId: EventIdEnum,
  params: Record<string, any>,
  extrinsic: any
) => {
  if (eventId === EventIdEnum.AssetCompliancePaused) {
    await handlePauseAssetCompliance(params);
  }
  if (eventId === EventIdEnum.AssetComplianceResumed) {
    await handleResumeAssetCompliance(params);
  }
  if (eventId === EventIdEnum.AssetComplianceReset) {
    await handleResetAssetCompliance(params);
  }
  if (eventId === EventIdEnum.ComplianceRequirementCreated) {
    await handleAddComplianceRequirement(params, extrinsic);
  }
  if (eventId === EventIdEnum.ComplianceRequirementRemoved) {
    await handleRemoveComplianceRequirement(params);
  }
};

const handleStatistics = async (eventId: EventIdEnum, params: Record<string, any>) => {
  if (eventId === EventIdEnum.TransferManagerAdded) {
    await handleAddTransferManager(params);
  }
  if (eventId === EventIdEnum.TransferManagerRemoved) {
    await handleRemoveTransferManager(params);
  }
  if (eventId === EventIdEnum.ExemptionsAdded) {
    await handleAddExemptedEntities(params);
  }
  if (eventId === EventIdEnum.ExemptionsRemoved) {
    await handleRemoveExemptedEntities(params);
  }
};

export async function mapAsset(
  blockId: number,
  eventId: EventIdEnum,
  moduleId: ModuleIdEnum,
  params: Record<string, any>,
  event: SubstrateEvent
): Promise<void> {
  if (moduleId === ModuleIdEnum.Asset) {
    await handleAsset(eventId, params, event);
  }
  if (moduleId === ModuleIdEnum.Identity) {
    await handleIdentity(eventId, params, event);
  }
  if (moduleId === ModuleIdEnum.Compliancemanager) {
    await handleComplianceManager(eventId, params, event);
  }
  if (moduleId === ModuleIdEnum.Statistics) {
    await handleStatistics(eventId, params);
  }
}
