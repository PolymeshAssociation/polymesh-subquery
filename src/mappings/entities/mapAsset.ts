import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import {
  Asset,
  AssetDocument,
  AssetHolder,
  AssetTransaction,
  CallIdEnum,
  EventIdEnum,
  Funding,
  ModuleIdEnum,
  SecurityIdentifier,
} from '../../types';
import {
  bytesToString,
  camelToSnakeCase,
  coerceHexToString,
  emptyDid,
  getBigIntValue,
  getBooleanValue,
  getDocValue,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  getNumberValue,
  getPortfolioValue,
  getSecurityIdentifiers,
  getTextValue,
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

export const createFunding = (
  blockId: string,
  ticker: string,
  event: SubstrateEvent,
  fundingRound: string,
  issuedAmount: bigint,
  totalFundingAmount: bigint
): Promise<void> => {
  return Funding.create({
    id: `${blockId}/${event.idx}`,
    assetId: ticker,
    fundingRound,
    amount: issuedAmount,
    totalFundingAmount,
    datetime: event.block.timestamp,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

const createAssetTransaction = (
  event: SubstrateEvent,
  blockId: string,
  details: Pick<
    AssetTransaction,
    'assetId' | 'toPortfolioId' | 'fromPortfolioId' | 'amount' | 'fundingRound'
  >
) => {
  const callId = camelToSnakeCase(event.extrinsic?.extrinsic.method.method || 'default');

  const callToEventMappings = {
    [CallIdEnum.issue]: EventIdEnum.Issued,
    [CallIdEnum.redeem]: EventIdEnum.Redeemed,
    [CallIdEnum.redeem_from_portfolio]: EventIdEnum.Redeemed,
    [CallIdEnum.controller_transfer]: EventIdEnum.ControllerTransfer,
    [CallIdEnum.push_benefit]: EventIdEnum.BenefitClaimed,
    [CallIdEnum.claim]: EventIdEnum.BenefitClaimed,
    [CallIdEnum.invest]: EventIdEnum.Invested,
    default: EventIdEnum.Transfer,
  };

  return AssetTransaction.create({
    id: `${blockId}/${event.idx}`,
    ...details,
    eventId: callToEventMappings[callId] || callToEventMappings['default'],
    eventIdx: event.idx,
    extrinsicIdx: event.extrinsic?.idx,
    datetime: event.block.timestamp,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
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
  event: SubstrateEvent
): Promise<void> => {
  const [, rawTicker, divisible, rawType, rawOwnerDid, ...rest] = params;
  let disableIu: Codec, rawIdentifiers: Codec, rawAssetName: Codec, rawFundingRoundName: Codec;

  /**
   * Events from chain >= 6.0.0 doesn't have disable investor uniqueness value
   * It defaults to false from 6.0.0
   */
  let isUniquenessRequired = false;

  if (event.block.specVersion >= 6000000) {
    [rawAssetName, rawIdentifiers, rawFundingRoundName] = rest;
  } else {
    [disableIu, rawAssetName, rawIdentifiers, rawFundingRoundName] = rest;
    isUniquenessRequired = !getBooleanValue(disableIu);
  }

  const ownerId = getTextValue(rawOwnerDid);
  const ticker = serializeTicker(rawTicker);
  const type = getTextValue(rawType);
  /**
   * Name isn't present on the old events so we need to query storage.
   * Events from chain >= 5.1.0 has it, and its faster to sync using it
   *
   * @note
   *   - For chain >= 5.0.0, asset.assetNames provides a hex value
   *   - For chain < 5.0.0, asset.assetNames provides name of the ticker in plain text. In case
   *       the name is not present, it return 12 bytes string containing TICKER value padded with \0 at the end.
   */
  const rawName = rawAssetName ?? (await api.query.asset.assetNames(rawTicker));
  const name = bytesToString(rawName);

  /**
   * FundingRound isn't present on the old events so we need to query storage.
   * Events from chain >= 5.1.0 has it, and its faster to sync using it
   */
  let fundingRound: string = null;

  const rawFundingRound = rawFundingRoundName ?? (await api.query.asset.fundingRound(rawTicker));
  if (!rawFundingRound.isEmpty) {
    fundingRound = bytesToString(rawFundingRound);
  }

  /**
   * Events from chain >= 5.1.0 has identifiers emitted as well
   * For older chains, this gets automatically populated with `IdentifiersUpdated` event
   */
  let identifiers: SecurityIdentifier[] = [];

  if (rawIdentifiers) {
    identifiers = getSecurityIdentifiers(rawIdentifiers);
  }

  await Asset.create({
    id: ticker,
    ticker,
    name,
    type,
    fundingRound,
    isDivisible: getBooleanValue(divisible),
    isFrozen: false,
    isUniquenessRequired,
    identifiers,
    ownerId,
    totalSupply: BigInt(0),
    totalTransfers: BigInt(0),
    isCompliancePaused: false,
    eventIdx: event.idx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

const handleAssetRenamed = async (blockId: string, params: Codec[]): Promise<void> => {
  const [, rawTicker, rawName] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.name = bytesToString(rawName);
  asset.updatedBlockId = blockId;

  await asset.save();
};

const handleFundingRoundSet = async (blockId: string, params: Codec[]): Promise<void> => {
  const [, rawTicker, rawFundingRound] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.fundingRound = bytesToString(rawFundingRound);
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
  const [, rawTicker, rawBeneficiaryDid, rawAmount, rawFundingRound, rawTotalFundingAmount] =
    params;

  const issuerDid = getTextValue(rawBeneficiaryDid);
  const ticker = serializeTicker(rawTicker);
  const issuedAmount = getBigIntValue(rawAmount);
  const fundingRound = bytesToString(rawFundingRound);
  const totalFundingAmount = getBigIntValue(rawTotalFundingAmount);

  const asset = await getAsset(ticker);
  asset.totalSupply += issuedAmount;
  asset.updatedBlockId = blockId;

  const assetIssuer = await getAssetHolder(ticker, issuerDid, blockId);
  assetIssuer.amount += issuedAmount;
  assetIssuer.updatedBlockId = blockId;

  const assetTransaction = AssetTransaction.create({
    id: `${blockId}/${event.idx}`,
    assetId: ticker,
    toPortfolioId: `${asset.ownerId}/0`, // Issued Assets are added to default Portfolio for the issuer
    eventId: EventIdEnum.Issued,
    eventIdx: event.idx,
    amount: issuedAmount,
    fundingRound,
    datetime: event.block.timestamp,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  });

  const promises = [asset.save(), assetIssuer.save(), assetTransaction.save()];
  if (fundingRound) {
    promises.push(
      createFunding(blockId, ticker, event, fundingRound, issuedAmount, totalFundingAmount)
    );
  }

  await Promise.all(promises);
};

const handleRedeemed = async (blockId: string, params: Codec[]): Promise<void> => {
  const [, rawTicker, rawBeneficiaryDid, rawAmount] = params;

  const issuerDid = getTextValue(rawBeneficiaryDid);
  const ticker = serializeTicker(rawTicker);
  const issuedAmount = getBigIntValue(rawAmount);

  const asset = await getAsset(ticker);
  asset.totalSupply -= issuedAmount;
  asset.updatedBlockId = blockId;

  const assetRedeemer = await getAssetHolder(ticker, issuerDid, blockId);
  assetRedeemer.amount -= issuedAmount;
  assetRedeemer.updatedBlockId = blockId;

  const promises = [asset.save(), assetRedeemer.save()];

  await Promise.all(promises);
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

const handleAssetTransfer = async (blockId: string, params: Codec[], event: SubstrateEvent) => {
  const [, rawTicker, rawFromPortfolio, rawToPortfolio, rawAmount] = params;
  const { identityId: fromDid, number: fromPortfolioNumber } = getPortfolioValue(rawFromPortfolio);
  const { identityId: toDid, number: toPortfolioNumber } = getPortfolioValue(rawToPortfolio);
  const ticker = serializeTicker(rawTicker);
  const transferAmount = getBigIntValue(rawAmount);

  let fromPortfolioId = `${fromDid}/${fromPortfolioNumber}`;
  let toPortfolioId = `${toDid}/${toPortfolioNumber}`;

  const promises = [];

  if (fromDid === emptyDid) {
    fromPortfolioId = null;
    return; // We ignore the transfer case when Asset tokens are issued
  }
  if (toDid === emptyDid) {
    // case for Assets being redeemed
    toPortfolioId = null;
  }

  if (fromPortfolioId && toPortfolioId) {
    const asset = await getAsset(ticker);
    asset.totalTransfers += BigInt(1);
    asset.updatedBlockId = blockId;
    promises.push(asset.save());

    const [fromHolder, toHolder] = await Promise.all([
      getAssetHolder(ticker, fromDid, blockId),
      getAssetHolder(ticker, toDid, blockId),
    ]);

    fromHolder.amount = fromHolder.amount - transferAmount;
    fromHolder.updatedBlockId = blockId;
    promises.push(fromHolder.save());

    toHolder.amount = toHolder.amount + transferAmount;
    toHolder.updatedBlockId = blockId;
    promises.push(toHolder.save());
  }

  promises.push(
    createAssetTransaction(event, blockId, {
      assetId: ticker,
      fromPortfolioId,
      toPortfolioId,
      amount: transferAmount,
    })
  );

  await Promise.all(promises);
};

const handleAssetBalanceUpdated = async (
  blockId: string,
  params: Codec[],
  event: SubstrateEvent
) => {
  const [, rawTicker, rawAmount, rawFromPortfolio, rawToPortfolio, rawUpdateReason] = params;

  let fromDid: string, toDid: string;

  let fromPortfolioNumber: number, toPortfolioNumber: number;

  const ticker = serializeTicker(rawTicker);
  const asset = await getAsset(ticker);

  let fromPortfolioId: string;
  let toPortfolioId: string;
  let fundingRoundName: string;

  const promises = [];

  const transferAmount = getBigIntValue(rawAmount);

  if (!rawFromPortfolio.isEmpty) {
    ({ identityId: fromDid, number: fromPortfolioNumber } = getPortfolioValue(rawFromPortfolio));

    fromPortfolioId = `${fromDid}/${fromPortfolioNumber}`;

    const fromHolder = await getAssetHolder(ticker, fromDid, blockId);
    fromHolder.amount = fromHolder.amount - transferAmount;
    fromHolder.updatedBlockId = blockId;
    promises.push(fromHolder.save());
  }

  if (!rawToPortfolio.isEmpty) {
    ({ identityId: toDid, number: toPortfolioNumber } = getPortfolioValue(rawToPortfolio));
    toPortfolioId = `${toDid}/${toPortfolioNumber}`;

    const toHolder = await getAssetHolder(ticker, toDid, blockId);
    toHolder.amount = toHolder.amount + transferAmount;
    toHolder.updatedBlockId = blockId;
    promises.push(toHolder.save());
  }

  const updateReason = getFirstKeyFromJson(rawUpdateReason);

  const value = getFirstValueFromJson(rawUpdateReason);

  if (updateReason === 'issued') {
    const issuedReason = value as unknown as { fundingRoundName: string };
    fundingRoundName = coerceHexToString(issuedReason.fundingRoundName);

    if (fundingRoundName) {
      promises.push(
        createFunding(blockId, ticker, event, fundingRoundName, transferAmount, transferAmount)
      );
    }

    asset.totalSupply += transferAmount;
    asset.updatedBlockId = blockId;
    promises.push(asset.save());
  } else if (updateReason === 'redeemed') {
    asset.totalSupply -= transferAmount;
    asset.updatedBlockId = blockId;
    promises.push(asset.save());
  } else if (updateReason === 'transferred') {
    asset.totalTransfers += BigInt(1);
    asset.updatedBlockId = blockId;
    promises.push(asset.save());
  }

  promises.push(
    createAssetTransaction(event, blockId, {
      assetId: ticker,
      fromPortfolioId,
      toPortfolioId,
      amount: transferAmount,
      fundingRound: fundingRoundName,
    })
  );

  await Promise.all(promises);
};

const handleAssetUpdateEvents = async (
  blockId: string,
  eventId: EventIdEnum,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> => {
  if (eventId === EventIdEnum.AssetCreated) {
    await handleAssetCreated(blockId, params, event);
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
    await handleAssetTransfer(blockId, params, event);
  }
  if (eventId === EventIdEnum.AssetBalanceUpdated) {
    await handleAssetBalanceUpdated(blockId, params, event);
  }
  await handleAssetUpdateEvents(blockId, eventId, params, event);

  // Unhandled asset events - CustomAssetTypeRegistered, CustomAssetTypeRegistered, ExtensionRemoved, IsIssueable, TickerRegistered, TickerTransferred, TransferWithData
}
