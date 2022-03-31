import { Codec } from '@polkadot/types/types';
import BigNumber from 'bignumber.js';
import { ModuleIdEnum, EventIdEnum } from './common';
import { Asset, AssetHolder, AssetTransferManager } from '../../types';
import {
  formatAssetIdentifiers,
  getDocValue,
  getNumberValue,
  getComplianceRulesValue,
  getTextValue,
  getComplianceValue,
  getTransferManagerValue,
  getExemptionsValue,
} from '../util';
import { SubstrateEvent } from '@subql/types';

// #region Utils
const chainAmountToBigNumber = (amount: number): BigNumber =>
  new BigNumber(amount).div(new BigNumber(1000000));

export const getAsset = async (ticker: string): Promise<Asset> => {
  const asset = await Asset.getByTicker(ticker);
  if (!asset) throw new Error(`Asset with ticker ${ticker} was not found.`);
  return asset;
};

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

const getTargetTransferManager = (
  manager: AssetTransferManager,
  managers: AssetTransferManager[]
) =>
  managers.find(
    e =>
      e.countTransferManager === manager.countTransferManager &&
      e.percentageTransferManager === manager.percentageTransferManager
  );

const excludeTransferManager = (manager: AssetTransferManager, managers: AssetTransferManager[]) =>
  managers.filter(
    e =>
      e.countTransferManager !== manager.countTransferManager ||
      e.percentageTransferManager !== manager.percentageTransferManager
  );
// #endregion

// #region ModuleIdEnum.Asset
const handleAssetCreated = async (params: Codec[]) => {
  const [rawOwnerDid, rawTicker, divisible, rawType, , disableIu] = params;
  const ownerDid = getTextValue(rawOwnerDid);
  const ticker = getTextValue(rawTicker);
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
    fundingRound: '',
    isDivisible: divisible,
    isFrozen: false,
    isUniquenessRequired: !disableIu,
    documents: [],
    identifiers: [],
    ownerDid,
    fullAgents: [ownerDid],
    totalSupply: '0',
    totalTransfers: '0',
    isCompliancePaused: false,
    compliance: [],
    transferManagers: [],
  }).save();
};

const handleAssetRenamed = async (params: Codec[]) => {
  const [, rawTicker, rawName] = params;
  const ticker = getTextValue(rawTicker);
  const newName = getTextValue(rawName);
  const asset = await getAsset(ticker);
  asset.name = newName;
  await asset.save();
};

const handleFundingRoundSet = async (params: Codec[]) => {
  const [, rawTicker, newFundingRound] = params;
  const ticker = getTextValue(rawTicker);
  const asset = await getAsset(ticker);
  asset.fundingRound = getTextValue(newFundingRound);
  await asset.save();
};

const handleDocumentAdded = async (params: Codec[]) => {
  const [, rawTicker, rawDocId, rawDoc] = params;
  const ticker = getTextValue(rawTicker);
  const id = getNumberValue(rawDocId);
  const { name, link } = getDocValue(rawDoc);
  const asset = await getAsset(ticker);
  asset.documents.push({
    id,
    name,
    link,
  });
  await asset.save();
};

const handleDocumentRemoved = async (params: Codec[]) => {
  const [, rawTicker, rawDocId] = params;
  const ticker = getTextValue(rawTicker);
  const docId = getNumberValue(rawDocId);
  const asset = await getAsset(ticker);
  asset.documents = asset.documents.filter(doc => docId !== doc.id);
  await asset.save();
};

const handleIdentifiersUpdated = async (params: Codec[]) => {
  const [, rawTicker, rawIdentifiers] = params;
  const stringIds = rawIdentifiers.toString();
  const newIdentifiers = JSON.parse(stringIds);
  const ticker = getTextValue(rawTicker);
  const asset = await getAsset(ticker);
  asset.identifiers = formatAssetIdentifiers(newIdentifiers);
  await asset.save();
};

const handleDivisibilityChanged = async (params: Codec[]) => {
  const [, rawTicker] = params;
  const ticker = getTextValue(rawTicker);
  const asset = await getAsset(ticker);
  asset.isDivisible = true;
  await asset.save();
};

const handleIssued = async (params: Codec[]) => {
  const [, rawTicker, , amount] = params;
  const ticker = getTextValue(rawTicker);
  const asset = await getAsset(ticker);
  const assetOwner = await getAssetHolder(asset.ownerDid, asset);
  const formattedAmount = chainAmountToBigNumber(getNumberValue(amount));
  assetOwner.amount = new BigNumber(assetOwner.amount).plus(formattedAmount).toString();
  asset.totalSupply = new BigNumber(asset.totalSupply).plus(formattedAmount).toString();
  await Promise.all([asset.save(), assetOwner.save()]);
};

const handleRedeemed = async (params: Codec[]) => {
  const [, rawTicker, , amount] = params;
  const ticker = getTextValue(rawTicker);
  const asset = await getAsset(ticker);
  const assetOwner = await getAssetHolder(asset.ownerDid, asset);
  const formattedAmount = chainAmountToBigNumber(getNumberValue(amount));
  assetOwner.amount = new BigNumber(assetOwner.amount).minus(formattedAmount).toString();
  asset.totalSupply = new BigNumber(asset.totalSupply).minus(formattedAmount).toString();
  await Promise.all([asset.save(), assetOwner.save()]);
};

const handleFrozen = async (params: Codec[]) => {
  const [, rawTicker] = params;
  const ticker = getTextValue(rawTicker);
  const asset = await getAsset(ticker);
  asset.isFrozen = true;
  await asset.save();
};

const handleUnfrozen = async (params: Codec[]) => {
  const [, rawTicker] = params;
  const ticker = getTextValue(rawTicker);
  const asset = await getAsset(ticker);
  asset.isFrozen = false;
  await asset.save();
};

const handleAssetOwnershipTransferred = async (params: Codec[]) => {
  const [to, rawTicker] = params;
  const ticker = getTextValue(rawTicker);
  const asset = await getAsset(ticker);
  asset.ownerDid = getTextValue(to);
  await asset.save();
};

// #region ModuleIdEnum.Compliancemanager
const handleAssetCompliancePaused = async (params: Codec[]) => {
  const [, rawTicker] = params;
  const ticker = getTextValue(rawTicker);
  const asset = await getAsset(ticker);
  asset.isCompliancePaused = true;
  await asset.save();
};

const handleAssetComplianceResumed = async (params: Codec[]) => {
  const [, rawTicker] = params;
  const ticker = getTextValue(rawTicker);
  const asset = await getAsset(ticker);
  asset.isCompliancePaused = false;
  await asset.save();
};

const handleAssetComplianceReset = async (params: Codec[]) => {
  const [, rawTicker] = params;
  const ticker = getTextValue(rawTicker);
  const asset = await getAsset(ticker);
  asset.compliance = [];
  await asset.save();
};

const handleComplianceRequirementCreated = async (params: Codec[]) => {
  const [, rawTicker, rawCompliance] = params;
  const ticker = getTextValue(rawTicker);
  const compliance = getComplianceValue(rawCompliance);
  const asset = await getAsset(ticker);
  asset.compliance.push(compliance);
  await asset.save();
};

const handleComplianceRequirementReplaced = async (params: Codec[]) => {
  const [, rawTicker, rawCompliance] = params;
  const ticker = getTextValue(rawTicker);
  const asset = await getAsset(ticker);
  asset.compliance = getComplianceRulesValue(rawCompliance); // looks like this should be complete set
  await asset.save();
};

const handleComplianceRequirementRemoved = async (params: Codec[]) => {
  const [, rawTicker, rawId] = params;
  const ticker = getTextValue(rawTicker);
  const asset = await getAsset(ticker);
  const id = getNumberValue(rawId);
  asset.compliance = asset.compliance.filter(c => c.id !== id);
  await asset.save();
};
// #endregion

// #region ModuleIdEnum.Externalagents
const handleTransferManagerAdded = async (params: Codec[]) => {
  const [, rawTicker, rawManager] = params;
  const ticker = getTextValue(rawTicker);
  const asset = await getAsset(ticker);
  const transferManager = getTransferManagerValue(rawManager);
  asset.transferManagers.push(transferManager);
  await asset.save();
};

const handleTransferManagerRemoved = async (params: Codec[]) => {
  const [, rawTicker, rawManager] = params;

  const ticker = getTextValue(rawTicker);
  const removedManager = getTransferManagerValue(rawManager);
  const asset = await getAsset(ticker);
  asset.transferManagers = excludeTransferManager(removedManager, asset.transferManagers);
  await asset.save();
};

const handleExemptionsAdded = async (params: Codec[]) => {
  const [, rawTicker, rawAgentGroup, rawExemptions] = params;
  const ticker = getTextValue(rawTicker);
  const asset = await getAsset(ticker);
  const parsedManager = getTransferManagerValue(rawAgentGroup);
  const parsedExemptions = getExemptionsValue(rawExemptions);

  const targetManager = getTargetTransferManager(parsedManager, asset.transferManagers);
  if (!targetManager) return;

  targetManager.exemptedEntities = [
    ...new Set<string>([...(parsedExemptions || []), ...(targetManager.exemptedEntities || [])]),
  ];
  const otherTransferManagers = excludeTransferManager(parsedManager, asset.transferManagers);
  asset.transferManagers = [...otherTransferManagers, targetManager];
  await asset.save();
};

const handleExemptionsRemoved = async (params: Codec[]) => {
  const [, rawTicker, rawTransferManager, rawExemptions] = params;
  const ticker = getTextValue(rawTicker);
  const asset = await getAsset(ticker);
  const parsedTransferManager = getTransferManagerValue(rawTransferManager);
  const parsedExemptions = getExemptionsValue(rawExemptions);

  const targetTransferManager = getTargetTransferManager(
    parsedTransferManager,
    asset.transferManagers
  );
  if (!targetTransferManager) return;

  targetTransferManager.exemptedEntities = (targetTransferManager.exemptedEntities || []).filter(
    e => !parsedExemptions.includes(e)
  );
  const otherTransferManagers = excludeTransferManager(
    parsedTransferManager,
    asset.transferManagers
  );
  asset.transferManagers = [...otherTransferManagers, targetTransferManager];
  await asset.save();
};
// #endregion

const handleAsset = async (eventId: EventIdEnum, params: Codec[]) => {
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
    await handleFrozen(params);
  }
  if (eventId === EventIdEnum.Unfrozen) {
    await handleUnfrozen(params);
  }
  if (eventId === EventIdEnum.AssetOwnershipTransferred) {
    await handleAssetOwnershipTransferred(params);
  }
};

const handleComplianceManager = async (eventId: EventIdEnum, params: Codec[]) => {
  if (eventId === EventIdEnum.AssetCompliancePaused) {
    await handleAssetCompliancePaused(params);
  }
  if (eventId === EventIdEnum.AssetComplianceResumed) {
    await handleAssetComplianceResumed(params);
  }
  if (eventId === EventIdEnum.AssetComplianceReset) {
    await handleAssetComplianceReset(params);
  }
  if (eventId === EventIdEnum.AssetComplianceReplaced) {
    await handleComplianceRequirementReplaced(params);
  }
  if (eventId === EventIdEnum.ComplianceRequirementCreated) {
    await handleComplianceRequirementCreated(params);
  }
  if (eventId === EventIdEnum.ComplianceRequirementRemoved) {
    await handleComplianceRequirementRemoved(params);
  }
};

const handleStatistics = async (eventId: EventIdEnum, params: Codec[]) => {
  if (eventId === EventIdEnum.TransferManagerAdded) {
    await handleTransferManagerAdded(params);
  }
  if (eventId === EventIdEnum.TransferManagerRemoved) {
    await handleTransferManagerRemoved(params);
  }
  if (eventId === EventIdEnum.ExemptionsAdded) {
    await handleExemptionsAdded(params);
  }
  if (eventId === EventIdEnum.ExemptionsRemoved) {
    await handleExemptionsRemoved(params);
  }
};

export async function mapAsset(
  _blockId: number,
  eventId: EventIdEnum,
  moduleId: ModuleIdEnum,
  params: Codec[],
  _event: SubstrateEvent
): Promise<void> {
  if (moduleId === ModuleIdEnum.Asset) {
    await handleAsset(eventId, params);
  }
  if (moduleId === ModuleIdEnum.Compliancemanager) {
    await handleComplianceManager(eventId, params);
  }
  if (moduleId === ModuleIdEnum.Statistics) {
    await handleStatistics(eventId, params);
  }
}
