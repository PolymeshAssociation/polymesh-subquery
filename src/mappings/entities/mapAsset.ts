import { Option, u64, U8aFixed } from '@polkadot/types-codec';
import { Codec } from '@polkadot/types/types';
import { SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import {
  Asset,
  AssetDocument,
  AssetHolder,
  AssetMandatoryMediator,
  AssetPreApproval,
  AssetTransaction,
  CallIdEnum,
  EventIdEnum,
  Funding,
  SecurityIdentifier,
} from '../../types';
import {
  bytesToString,
  camelToSnakeCase,
  coerceHexToString,
  emptyDid,
  getAssetType,
  getBigIntValue,
  getBooleanValue,
  getDocValue,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  getStringArrayValue,
  getNumberValue,
  getPortfolioValue,
  getSecurityIdentifiers,
  getTextValue,
  serializeTicker,
} from '../util';
import { extractArgs, getAsset } from './common';

export const createFunding = (
  blockId: string,
  ticker: string,
  eventIdx: number,
  datetime: Date,
  fundingRound: string,
  issuedAmount: bigint,
  totalFundingAmount: bigint
): Promise<void> => {
  return Funding.create({
    id: `${blockId}/${eventIdx}`,
    assetId: ticker,
    fundingRound,
    amount: issuedAmount,
    totalFundingAmount,
    datetime,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const createAssetTransaction = (
  blockId: string,
  eventIdx: number,
  datetime: Date,
  details: Pick<
    AssetTransaction,
    | 'assetId'
    | 'toPortfolioId'
    | 'fromPortfolioId'
    | 'amount'
    | 'fundingRound'
    | 'nftIds'
    | 'instructionId'
    | 'instructionMemo'
  >,
  eventId?: EventIdEnum,
  extrinsic?: SubstrateExtrinsic
): Promise<void> => {
  const callId = camelToSnakeCase(extrinsic?.extrinsic.method.method || 'default');

  const callToEventMappings = {
    [CallIdEnum.issue]: EventIdEnum.Issued,
    [CallIdEnum.redeem]: EventIdEnum.Redeemed,
    [CallIdEnum.redeem_from_portfolio]: EventIdEnum.Redeemed,
    [CallIdEnum.controller_transfer]: EventIdEnum.ControllerTransfer,
    [CallIdEnum.push_benefit]: EventIdEnum.BenefitClaimed,
    [CallIdEnum.claim]: EventIdEnum.BenefitClaimed,
    [CallIdEnum.invest]: EventIdEnum.Invested,
    [CallIdEnum.issue_nft]: EventIdEnum.IssuedNFT,
    [CallIdEnum.redeem_nft]: EventIdEnum.RedeemedNFT,
    default: EventIdEnum.Transfer,
  };

  return AssetTransaction.create({
    id: `${blockId}/${eventIdx}`,
    ...details,
    // adding in fall back for `eventId` helps in identifying cases where utility.batchAtomic is used as extrinsic
    eventId: callToEventMappings[callId] || eventId || callToEventMappings['default'],
    eventIdx,
    extrinsicIdx: extrinsic?.idx,
    datetime,
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

export const handleAssetCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, block, eventIdx, blockId } = extractArgs(event);
  const [, rawTicker, divisible, rawType, rawOwnerDid, ...rest] = params;
  let disableIu: Codec, rawIdentifiers: Codec, rawAssetName: Codec, rawFundingRoundName: Codec;

  /**
   * Events from chain >= 6.0.0 doesn't have disable investor uniqueness value
   * It defaults to false from 6.0.0
   *
   * NOTE - for Polymesh Private SDK the spec version starts again from 1.0.0
   */
  let isUniquenessRequired = false;

  const specName = api.runtimeVersion.specName.toString();
  if (block.specVersion >= 6000000 || specName === 'polymesh_private_dev') {
    [rawAssetName, rawIdentifiers, rawFundingRoundName] = rest;
  } else {
    [disableIu, rawAssetName, rawIdentifiers, rawFundingRoundName] = rest;
    isUniquenessRequired = !getBooleanValue(disableIu);
  }

  const ownerId = getTextValue(rawOwnerDid);
  const ticker = serializeTicker(rawTicker);

  /**
   * Name isn't present on the old events so we need to query storage.
   * Events from chain >= 5.1.0 has it, and its faster to sync using it
   *
   * @note
   *   - For chain >= 5.0.0, asset.assetNames provides a hex value
   *   - For chain < 5.0.0, asset.assetNames provides name of the ticker in plain text. In case
   *       the name is not present, it return 12 bytes string containing TICKER value padded with \0 at the end.
   */

  const [assetType, rawName, rawFundingRound] = await Promise.all([
    getAssetType(rawType),
    rawAssetName ?? api.query.asset.assetNames(rawTicker),
    rawFundingRoundName ?? api.query.asset.fundingRound(rawTicker),
  ]);

  const name = bytesToString(rawName);
  /**
   * FundingRound isn't present on the old events so we need to query storage.
   * Events from chain >= 5.1.0 has it, and its faster to sync using it
   */
  let fundingRound: string = null;

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
    type: assetType,
    isNftCollection: false, // collection creation will emit a separate event
    fundingRound,
    isDivisible: getBooleanValue(divisible),
    isFrozen: false,
    isUniquenessRequired,
    identifiers,
    ownerId,
    totalSupply: BigInt(0),
    totalTransfers: BigInt(0),
    isCompliancePaused: false,
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const handleAssetRenamed = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawTicker, rawName] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.name = bytesToString(rawName);
  asset.updatedBlockId = blockId;

  await asset.save();
};

export const handleFundingRoundSet = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawTicker, rawFundingRound] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);

  asset.fundingRound = bytesToString(rawFundingRound);
  asset.updatedBlockId = blockId;

  await asset.save();
};

export const handleDocumentAdded = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
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

export const handleDocumentRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { params } = extractArgs(event);
  const [, rawTicker, rawDocId] = params;

  const ticker = serializeTicker(rawTicker);
  const documentId = getNumberValue(rawDocId);

  await AssetDocument.remove(`${ticker}/${documentId}`);
};

export const handleIdentifiersUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawTicker, rawIdentifiers] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.identifiers = getSecurityIdentifiers(rawIdentifiers);
  asset.updatedBlockId = blockId;

  await asset.save();
};

export const handleDivisibilityChanged = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawTicker] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.isDivisible = true;
  asset.updatedBlockId = blockId;

  await asset.save();
};

export const handleIssued = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, eventIdx, extrinsic, block } = extractArgs(event);
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
    id: `${blockId}/${eventIdx}`,
    assetId: ticker,
    toPortfolioId: `${asset.ownerId}/0`, // Issued Assets are added to default Portfolio for the issuer
    eventId: EventIdEnum.Issued,
    eventIdx,
    amount: issuedAmount,
    fundingRound,
    extrinsicIdx: extrinsic?.idx,
    datetime: block.timestamp,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  });

  const promises = [asset.save(), assetIssuer.save(), assetTransaction.save()];
  if (fundingRound) {
    promises.push(
      createFunding(
        blockId,
        ticker,
        eventIdx,
        block.timestamp,
        fundingRound,
        issuedAmount,
        totalFundingAmount
      )
    );
  }

  await Promise.all(promises);
};

export const handleRedeemed = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
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

export const handleFrozen = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawTicker] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.isFrozen = true;
  asset.updatedBlockId = blockId;

  await asset.save();
};

export const handleUnfrozen = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawTicker] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.isFrozen = false;
  asset.updatedBlockId = blockId;

  await asset.save();
};

export const handleAssetOwnershipTransferred = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);

  const [to, rawTicker] = params;

  const ticker = serializeTicker(rawTicker);

  const asset = await getAsset(ticker);
  asset.ownerId = getTextValue(to);
  asset.updatedBlockId = blockId;

  await asset.save();
};

export const handleAssetTransfer = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block, eventIdx, extrinsic } = extractArgs(event);
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

  let instructionId: string;

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

    // For old `Transfer` events, `InstructionExecuted` event was separately emitted in the same block
    const instructionExecutedEvent = block.events.find(
      ({ event }) => event.method === 'InstructionExecuted'
    );
    if (instructionExecutedEvent) {
      instructionId = getTextValue(instructionExecutedEvent.event.data[1]);
    }
  }

  promises.push(
    createAssetTransaction(
      blockId,
      eventIdx,
      block.timestamp,
      {
        assetId: ticker,
        fromPortfolioId,
        toPortfolioId,
        amount: transferAmount,
        instructionId,
      },
      EventIdEnum.Transfer,
      extrinsic
    )
  );

  await Promise.all(promises);
};

export const handleAssetBalanceUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, eventIdx, block, extrinsic } = extractArgs(event);
  const [, rawTicker, rawAmount, rawFromPortfolio, rawToPortfolio, rawUpdateReason] = params;

  let fromDid: string, toDid: string;

  let fromPortfolioNumber: number, toPortfolioNumber: number;

  const ticker = serializeTicker(rawTicker);
  const asset = await getAsset(ticker);

  let fromPortfolioId: string;
  let toPortfolioId: string;
  let fundingRoundName: string;
  let instructionId: string;
  let instructionMemo: string;

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

  let eventId: EventIdEnum;
  if (updateReason === 'issued') {
    eventId = EventIdEnum.Issued;
    const issuedReason = value as unknown as { fundingRoundName: string };
    fundingRoundName = coerceHexToString(issuedReason.fundingRoundName);

    if (fundingRoundName) {
      promises.push(
        createFunding(
          blockId,
          ticker,
          eventIdx,
          block.timestamp,
          fundingRoundName,
          transferAmount,
          transferAmount
        )
      );
    }

    asset.totalSupply += transferAmount;
    asset.updatedBlockId = blockId;
    promises.push(asset.save());
  } else if (updateReason === 'redeemed') {
    eventId = EventIdEnum.Redeemed;
    asset.totalSupply -= transferAmount;
    asset.updatedBlockId = blockId;
    promises.push(asset.save());
  } else if (updateReason === 'transferred') {
    const details = value as unknown as {
      readonly instructionId: Option<u64>;
      readonly instructionMemo: Option<U8aFixed>;
    };

    instructionId = getTextValue(details.instructionId);
    instructionMemo = bytesToString(details.instructionMemo);

    eventId = EventIdEnum.Transfer;
    if (!instructionId) {
      eventId = block.events[eventIdx + 1]?.event?.method as EventIdEnum;
    }

    asset.totalTransfers += BigInt(1);
    asset.updatedBlockId = blockId;
    promises.push(asset.save());
  }

  promises.push(
    createAssetTransaction(
      blockId,
      eventIdx,
      block.timestamp,
      {
        assetId: ticker,
        fromPortfolioId,
        toPortfolioId,
        amount: transferAmount,
        fundingRound: fundingRoundName,
        instructionId,
        instructionMemo,
      },
      eventId,
      extrinsic
    )
  );

  await Promise.all(promises);
};

export const handleAssetMediatorsAdded = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const addedById = getTextValue(params[0]);
  const ticker = serializeTicker(params[1]);
  const mediators = getStringArrayValue(params[2]);

  const createPromises = mediators.map(mediator =>
    AssetMandatoryMediator.create({
      id: `${ticker}/${mediator}`,
      identityId: mediator,
      assetId: ticker,
      addedById,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save()
  );

  await Promise.all(createPromises);
};

export const handleAssetMediatorsRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { params } = extractArgs(event);
  const ticker = serializeTicker(params[1]);
  const mediators = getStringArrayValue(params[2]);

  await Promise.all(
    mediators.map(mediator => AssetMandatoryMediator.remove(`${ticker}/${mediator}`))
  );
};

export const handlePreApprovedAsset = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const identityId = getTextValue(params[0]);
  const assetId = serializeTicker(params[1]);

  await AssetPreApproval.create({
    id: `${assetId}/${identityId}`,
    assetId,
    identityId,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const handleRemovePreApprovedAsset = async (event: SubstrateEvent): Promise<void> => {
  const { params } = extractArgs(event);

  const identityId = getTextValue(params[0]);
  const assetId = serializeTicker(params[1]);

  await AssetPreApproval.remove(`${assetId}/${identityId}`);
};
