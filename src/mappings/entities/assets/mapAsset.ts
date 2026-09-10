import { EventRecord } from '@polkadot/types/interfaces';
import { Codec } from '@polkadot/types/types';
import { SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import { decodeEvent } from '../../../decode';
import {
  Asset,
  AssetDocument,
  AssetHolder,
  AssetAllowance,
  AssetMandatoryMediator,
  AssetPreApproval,
  AssetTransaction,
  CallIdEnum,
  EventIdEnum,
  Funding,
  HolderKind,
  Holding,
  SecurityIdentifier,
} from '../../../types';
import {
  accountHolder,
  AssetHolderDetails,
  bytesToString,
  camelToSnakeCase,
  classifyInternalTransfer,
  coerceHexToString,
  emptyDid,
  getAssetId,
  getAssetType,
  getBigIntValue,
  getBooleanValue,
  getDocValue,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  getNumberValue,
  getOrCreateAccount,
  getPortfolioId,
  getSecurityIdentifiers,
  getStringArrayValue,
  getTextValue,
  is7xChain,
  isMigratedAssetId,
  padNumericId,
  rawAssetHolderToAssetHolder,
  serializeTicker,
} from '../../../utils';
import { processInstructionId } from '../settlements/mapSettlement';
import { extractArgs, getAsset, getAssetOrAnomaly } from './../common';

export const createFunding = (
  blockId: string,
  assetId: string,
  blockEventId: string,
  datetime: Date,
  fundingRound: string,
  issuedAmount: bigint,
  totalFundingAmount: bigint
): Promise<void> => {
  return Funding.create({
    id: blockEventId,
    assetId,
    fundingRound,
    amount: issuedAmount,
    totalFundingAmount,
    datetime,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};

export const createAssetTransaction = (
  blockId: string,
  eventIdx: number,
  datetime: Date,
  details: Pick<
    AssetTransaction,
    | 'assetId'
    | 'amount'
    | 'fundingRound'
    | 'nftIds'
    | 'instructionId'
    | 'instructionMemo'
    | 'memo'
    | 'address'
  > & { fromHolder?: AssetHolderDetails; toHolder?: AssetHolderDetails },
  blockEventId: string,
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

  let fromIdentityId: string;
  let fromAccount: string;
  let fromPortfolioId: string;
  let toIdentityId: string;
  let toAccount: string;
  let toPortfolioId: string;

  if (details.fromHolder) {
    fromIdentityId = details.fromHolder.identityId;
    if ('account' in details.fromHolder) {
      fromAccount = details.fromHolder.account;
    } else {
      fromPortfolioId = getPortfolioId(details.fromHolder);
    }
  }

  if (details.toHolder) {
    toIdentityId = details.toHolder.identityId;
    if ('account' in details.toHolder) {
      toAccount = details.toHolder.account;
    } else {
      toPortfolioId = getPortfolioId(details.toHolder);
    }
  }

  return AssetTransaction.create({
    id: blockEventId,
    ...details,
    // adding in fall back for `eventId` helps in identifying cases where utility.batchAtomic is used as extrinsic
    eventId: callToEventMappings[callId] || eventId || callToEventMappings['default'],
    // classified on holder presence first, DID equality second — an unresolved holder is
    // present, not absent, and must never read as an issuance/redemption
    isInternalTransfer: classifyInternalTransfer(details.fromHolder, details.toHolder),
    fromPortfolioId,
    fromAccount,
    fromIdentityId,
    toPortfolioId,
    toAccount,
    toIdentityId,
    eventIdx,
    extrinsicIdx: extrinsic?.idx,
    datetime,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};

export const getAssetHolder = async (
  assetId: string,
  did: string,
  blockId: string
): Promise<AssetHolder> => {
  const id = `${assetId}/${did}`;

  let assetHolder = await AssetHolder.get(id);

  if (!assetHolder) {
    assetHolder = AssetHolder.create({
      id,
      identityId: did,
      assetId,
      amount: BigInt(0),
      createdBlockId: blockId,
      updatedBlockId: blockId,
    });
    await assetHolder.save();
  }

  return assetHolder;
};

const holdingId = (assetId: string, holder: AssetHolderDetails): string =>
  holder.holderKind === HolderKind.Account
    ? `${assetId}/${holder.account}`
    : `${assetId}/${getPortfolioId(holder)}`;

export const getHolding = async (
  assetId: string,
  holder: AssetHolderDetails,
  blockId: string
): Promise<Holding> => {
  const id = holdingId(assetId, holder);

  let holding = await Holding.get(id);

  if (!holding) {
    holding = Holding.create({
      id,
      assetId,
      holderKind: holder.holderKind,
      portfolioId: holder.holderKind === HolderKind.Portfolio ? getPortfolioId(holder) : undefined,
      accountId: holder.holderKind === HolderKind.Account ? holder.account : undefined,
      identityId: holder.identityId || undefined,
      amount: BigInt(0),
      nftCount: 0,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    });
  }

  return holding;
};

/**
 * Applies a fungible delta to one holder: the portfolio/account-grain `Holding` row it is the
 * primary truth for, and the identity-grain `AssetHolder` rollup kept alongside (plan 03
 * recommendation (b) — the SDK queries the rollup directly, and one row version per touched
 * block is cheap). `Asset.holderCount` follows the rollup crossing zero.
 *
 * The rollup and `holderCount` are only touched when the holder resolves to a DID — an
 * account-grain holder with no known Identity still gets its `Holding` row, and must not be
 * folded into a DID rollup it does not belong to.
 */
export const applyHoldingDelta = async (
  asset: Asset,
  holder: AssetHolderDetails,
  blockId: string,
  delta: bigint,
  promises: Promise<void>[]
): Promise<void> => {
  const holding = await getHolding(asset.id, holder, blockId);
  holding.amount += delta;
  holding.updatedBlockId = blockId;
  promises.push(holding.save());

  if (!holder.identityId) {
    return;
  }

  const rollup = await getAssetHolder(asset.id, holder.identityId, blockId);
  const before = rollup.amount;
  rollup.amount += delta;
  rollup.updatedBlockId = blockId;
  promises.push(rollup.save());

  if (before <= BigInt(0) && rollup.amount > BigInt(0)) {
    asset.holderCount += 1;
  } else if (before > BigInt(0) && rollup.amount <= BigInt(0)) {
    asset.holderCount = Math.max(0, asset.holderCount - 1);
  }
};

export const handleAssetCreated = async (event: SubstrateEvent): Promise<void> => {
  const { block, eventIdx, blockId, blockEventId } = extractArgs(event);
  const decoded = decodeEvent(event);
  const {
    assetId: rawAssetId,
    divisible,
    assetType: rawType,
    ownerDid: rawOwnerDid,
    name: rawAssetName,
    identifiers: rawIdentifiers,
    fundingRound: rawFundingRoundName,
  } = decoded;

  const ownerId = getTextValue(rawOwnerDid);

  const ticker =
    is7xChain(block) || isMigratedAssetId(rawAssetId) ? undefined : serializeTicker(rawAssetId);

  /**
   * Name isn't present on the old events so we need to query storage.
   * Events from chain >= 5.1.0 has it, and its faster to sync using it
   *
   * @note
   *   - For chain >= 5.0.0, asset.assetNames provides a hex value
   *   - For chain < 5.0.0, asset.assetNames provides name of the ticker in plain text. In case
   *       the name is not present, it return 12 bytes string containing TICKER value padded with \0 at the end.
   */

  // `assetNames`/`fundingRound` key on a fixed-width codec: `AssetId` (16 bytes) on 7.x+,
  // `Ticker` (12 bytes) before it. `.toU8a()` is those exact bytes in both eras, so this is
  // an explicit encoding of what was previously an implicit `Codec` coercion, not a behaviour
  // change.
  const [assetType, rawName, rawFundingRound] = await Promise.all([
    getAssetType(rawType),
    rawAssetName ?? api.query.asset.assetNames(rawAssetId.toU8a()),
    rawFundingRoundName ?? api.query.asset.fundingRound(rawAssetId.toU8a()),
  ]);

  const name = bytesToString(rawName as Codec);
  /**
   * FundingRound isn't present on the old events so we need to query storage.
   * Events from chain >= 5.1.0 has it, and its faster to sync using it
   */
  let fundingRound: string = null;

  if (!rawFundingRound.isEmpty) {
    fundingRound = bytesToString(rawFundingRound as Codec);
  }

  /**
   * Events from chain >= 5.1.0 has identifiers emitted as well
   * For older chains, this gets automatically populated with `IdentifiersUpdated` event
   */
  let identifiers: SecurityIdentifier[] = [];

  if (rawIdentifiers) {
    identifiers = getSecurityIdentifiers(rawIdentifiers);
  }

  const assetId = await getAssetId(rawAssetId, block);

  await Asset.create({
    id: assetId,
    assetId,
    ticker,
    name,
    type: assetType,
    isNftCollection: false, // collection creation will emit a separate event
    fundingRound,
    isDivisible: getBooleanValue(divisible),
    isFrozen: false,
    holderCount: 0,
    identifiers,
    ownerId,
    totalSupply: BigInt(0),
    totalTransfers: BigInt(0),
    isCompliancePaused: false,
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};

export const handleAssetRenamed = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block } = extractArgs(event);
  const { assetId: rawAssetId, name: rawName } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);

  const asset = await getAsset(assetId);
  asset.name = bytesToString(rawName);
  asset.updatedBlockId = blockId;

  await asset.save();
};

export const handleFundingRoundSet = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block } = extractArgs(event);
  const { assetId: rawAssetId, fundingRound: rawFundingRound } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);

  const asset = await getAsset(assetId);

  asset.fundingRound = bytesToString(rawFundingRound);
  asset.updatedBlockId = blockId;

  await asset.save();
};

export const handleDocumentAdded = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block } = extractArgs(event);
  const { assetId: rawAssetId, documentId: rawDocId, document: rawDoc } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const documentId = getNumberValue(rawDocId);
  const docDetails = getDocValue(rawDoc);

  await getAsset(assetId);

  await AssetDocument.create({
    id: `${assetId}/${documentId}`,
    documentId,
    ...docDetails,
    assetId,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const handleDocumentRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { block } = extractArgs(event);
  const { assetId: rawAssetId, documentId: rawDocId } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const documentId = getNumberValue(rawDocId);

  await AssetDocument.remove(`${assetId}/${documentId}`);
};

export const handleIdentifiersUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block } = extractArgs(event);
  const { assetId: rawAssetId, identifiers: rawIdentifiers } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);

  const asset = await getAsset(assetId);
  asset.identifiers = getSecurityIdentifiers(rawIdentifiers);
  asset.updatedBlockId = blockId;

  await asset.save();
};

export const handleDivisibilityChanged = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block } = extractArgs(event);
  const { assetId: rawAssetId } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);

  const asset = await getAsset(assetId);
  asset.isDivisible = true;
  asset.updatedBlockId = blockId;

  await asset.save();
};

export const handleIssued = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, eventIdx, extrinsic, block, blockEventId } = extractArgs(event);
  const {
    assetId: rawAssetId,
    beneficiaryDid: rawBeneficiaryDid,
    amount: rawAmount,
    fundingRound: rawFundingRound,
    totalFundingAmount: rawTotalFundingAmount,
  } = decodeEvent(event);

  const issuerDid = getTextValue(rawBeneficiaryDid);
  const assetId = await getAssetId(rawAssetId, block);
  const issuedAmount = getBigIntValue(rawAmount);
  const fundingRound = bytesToString(rawFundingRound);
  const totalFundingAmount = getBigIntValue(rawTotalFundingAmount);

  const asset = await getAsset(assetId);
  asset.totalSupply += issuedAmount;
  asset.updatedBlockId = blockId;

  const assetIssuer = await getAssetHolder(assetId, issuerDid, blockId);
  assetIssuer.amount += issuedAmount;
  assetIssuer.updatedBlockId = blockId;

  const assetTransaction = AssetTransaction.create({
    id: blockEventId,
    assetId,
    toPortfolioId: `${asset.ownerId}/0`, // Issued Assets are added to default Portfolio for the issuer
    toIdentityId: issuerDid,
    eventId: EventIdEnum.Issued,
    eventIdx,
    amount: issuedAmount,
    fundingRound,
    extrinsicIdx: extrinsic?.idx,
    datetime: block.timestamp,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  });

  const promises = [asset.save(), assetIssuer.save(), assetTransaction.save()];
  if (fundingRound) {
    promises.push(
      createFunding(
        blockId,
        assetId,
        blockEventId,
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
  const { blockId, block } = extractArgs(event);
  const {
    assetId: rawAssetId,
    beneficiaryDid: rawBeneficiaryDid,
    amount: rawAmount,
  } = decodeEvent(event);

  const issuerDid = getTextValue(rawBeneficiaryDid);
  const assetId = await getAssetId(rawAssetId, block);
  const issuedAmount = getBigIntValue(rawAmount);

  const asset = await getAsset(assetId);
  asset.totalSupply -= issuedAmount;
  asset.updatedBlockId = blockId;

  const assetRedeemer = await getAssetHolder(assetId, issuerDid, blockId);
  assetRedeemer.amount -= issuedAmount;
  assetRedeemer.updatedBlockId = blockId;

  const promises = [asset.save(), assetRedeemer.save()];

  await Promise.all(promises);
};

export const handleFrozen = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block } = extractArgs(event);
  const { assetId: rawAssetId } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);

  const asset = await getAsset(assetId);
  asset.isFrozen = true;
  asset.updatedBlockId = blockId;

  await asset.save();
};

export const handleUnfrozen = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block } = extractArgs(event);
  const { assetId: rawAssetId } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);

  const asset = await getAsset(assetId);
  asset.isFrozen = false;
  asset.updatedBlockId = blockId;

  await asset.save();
};

export const handleAssetOwnershipTransferred = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block } = extractArgs(event);
  const { did: rawNewOwnerDid, assetId: rawAssetId } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);

  const asset = await getAsset(assetId);
  asset.ownerId = getTextValue(rawNewOwnerDid);
  asset.updatedBlockId = blockId;

  await asset.save();
};

export const handleAssetTransfer = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block, eventIdx, extrinsic, blockEventId } = extractArgs(event);
  const {
    assetId: rawAssetId,
    fromHolder: rawFromHolder,
    toHolder: rawToHolder,
    amount: rawAmount,
  } = decodeEvent(event);
  const assetId = await getAssetId(rawAssetId, block);
  const transferAmount = getBigIntValue(rawAmount);

  let fromHolder: AssetHolderDetails | undefined;
  let fromDid: string;
  let toDid: string;

  if (!rawFromHolder.isEmpty) {
    fromHolder = await rawAssetHolderToAssetHolder(rawFromHolder, block, blockId);
    fromDid = fromHolder.identityId;
    if (fromDid === emptyDid) {
      return; // We ignore the transfer case when Asset tokens are issued
    }
  }

  let toHolder: AssetHolderDetails | undefined;

  if (!rawToHolder.isEmpty) {
    toHolder = await rawAssetHolderToAssetHolder(rawToHolder, block, blockId);
    toDid = toHolder.identityId;
    if (toDid === emptyDid) {
      toDid = null;
      toHolder = null; // case for Assets being redeemed
    }
  }

  let instructionId: string;

  const promises = [];

  if (fromHolder && toHolder) {
    const asset = await getAsset(assetId);
    asset.totalTransfers += BigInt(1);
    asset.updatedBlockId = blockId;
    promises.push(asset.save());

    const [fromHolder, toHolder] = await Promise.all([
      getAssetHolder(assetId, fromDid, blockId),
      getAssetHolder(assetId, toDid, blockId),
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
      instructionId = processInstructionId(
        instructionExecutedEvent.event.data[1] as unknown as Codec
      );
    }
  }

  promises.push(
    createAssetTransaction(
      blockId,
      eventIdx,
      block.timestamp,
      {
        assetId,
        fromHolder,
        toHolder,
        amount: transferAmount,
        instructionId,
      },
      blockEventId,
      EventIdEnum.Transfer,
      extrinsic
    )
  );

  await Promise.all(promises);
};

type UpdateReasonResult = {
  eventId: EventIdEnum;
  fundingRoundName?: string;
  instructionId?: string;
  instructionMemo?: string;
  assetDelta: { totalSupply?: bigint; totalTransfers?: bigint };
};

export const processUpdateReason = (
  updateReason: string,
  value: unknown,
  transferAmount: bigint,
  eventIdx: number,
  blockEvents: EventRecord[]
): UpdateReasonResult => {
  if (updateReason === 'issued') {
    const { fundingRoundName: rawName } = value as { fundingRoundName: string };
    return {
      eventId: EventIdEnum.Issued,
      fundingRoundName: coerceHexToString(rawName),
      assetDelta: { totalSupply: transferAmount },
    };
  }

  if (updateReason === 'redeemed') {
    return {
      eventId: EventIdEnum.Redeemed,
      assetDelta: { totalSupply: -transferAmount },
    };
  }

  if (updateReason === 'transferred') {
    const details = value as {
      instructionId: number | null;
      instructionMemo: `0x${string}` | null;
    };
    // FK to the padded `Instruction.id` (D12) — must carry the same zero-padding
    const instructionId = details.instructionId
      ? padNumericId(details.instructionId.toString())
      : null;
    const instructionMemo = details.instructionMemo
      ? coerceHexToString(details.instructionMemo)
      : null;
    const eventId = instructionId
      ? EventIdEnum.Transfer
      : (blockEvents[eventIdx + 1]?.event.method as EventIdEnum) ?? EventIdEnum.Unknown;
    return { eventId, instructionId, instructionMemo, assetDelta: { totalTransfers: BigInt(1) } };
  }

  if (updateReason === 'controllerTransfer') {
    // A controller transfer is a transfer: count it, and pin the event id so a
    // batched controller_transfer does not fall back to the wrapping call name.
    return {
      eventId: EventIdEnum.ControllerTransfer,
      assetDelta: { totalTransfers: BigInt(1) },
    };
  }

  return { eventId: undefined, assetDelta: {} };
};

export const handleAssetBalanceUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, eventIdx, block, extrinsic, blockEventId } = extractArgs(event);
  const {
    assetId: rawAssetId,
    amount: rawAmount,
    fromHolder: rawFromHolder,
    toHolder: rawToHolder,
    updateReason: rawUpdateReason,
  } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const asset = await getAssetOrAnomaly(assetId, {
    block,
    eventIdx,
    eventId: EventIdEnum.Transfer,
  });

  if (!asset) {
    return;
  }

  const transferAmount = getBigIntValue(rawAmount);
  const promises: Promise<void>[] = [];

  let fromHolder: AssetHolderDetails | undefined;

  if (!rawFromHolder.isEmpty) {
    fromHolder = await rawAssetHolderToAssetHolder(rawFromHolder, block, blockId);
    await applyHoldingDelta(asset, fromHolder, blockId, -transferAmount, promises);
  }
  let toHolder: AssetHolderDetails | undefined;

  if (!rawToHolder.isEmpty) {
    toHolder = await rawAssetHolderToAssetHolder(rawToHolder, block, blockId);
    await applyHoldingDelta(asset, toHolder, blockId, transferAmount, promises);
  }

  const updateReason = getFirstKeyFromJson(rawUpdateReason);
  const value = getFirstValueFromJson(rawUpdateReason);

  const { eventId, fundingRoundName, instructionId, instructionMemo, assetDelta } =
    processUpdateReason(
      updateReason,
      value,
      transferAmount,
      eventIdx,
      block.events as unknown as EventRecord[]
    );

  if (assetDelta.totalSupply !== undefined) {
    asset.totalSupply += assetDelta.totalSupply;
  }
  if (assetDelta.totalTransfers !== undefined) {
    asset.totalTransfers += assetDelta.totalTransfers;
  }
  if (
    assetDelta.totalSupply !== undefined ||
    assetDelta.totalTransfers !== undefined ||
    fromHolder ||
    toHolder
  ) {
    // one save persists the supply/transfer deltas and any holderCount change applyHoldingDelta
    // made to this same in-memory Asset
    asset.updatedBlockId = blockId;
    promises.push(asset.save());
  }

  if (fundingRoundName) {
    promises.push(
      createFunding(
        blockId,
        assetId,
        blockEventId,
        block.timestamp,
        fundingRoundName,
        transferAmount,
        transferAmount
      )
    );
  }

  promises.push(
    createAssetTransaction(
      blockId,
      eventIdx,
      block.timestamp,
      {
        assetId,
        fromHolder,
        toHolder,
        amount: transferAmount,
        fundingRound: fundingRoundName,
        instructionId,
        instructionMemo,
      },
      blockEventId,
      eventId,
      extrinsic
    )
  );

  await Promise.all(promises);
};

export const handleAssetMediatorsAdded = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block } = extractArgs(event);
  const { did, assetId: rawAssetId, mediators: rawMediators } = decodeEvent(event);

  const addedById = getTextValue(did);
  const assetId = await getAssetId(rawAssetId, block);
  const mediators = getStringArrayValue(rawMediators);

  const createPromises = mediators.map(mediator =>
    AssetMandatoryMediator.create({
      id: `${assetId}/${mediator}`,
      identityId: mediator,
      assetId,
      addedById,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save()
  );

  await Promise.all(createPromises);
};

export const handleAssetMediatorsRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { block } = extractArgs(event);
  const { assetId: rawAssetId, mediators: rawMediators } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const mediators = getStringArrayValue(rawMediators);

  await Promise.all(
    mediators.map(mediator => AssetMandatoryMediator.remove(`${assetId}/${mediator}`))
  );
};

export const handlePreApprovedAsset = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block } = extractArgs(event);
  const { did, assetId: rawAssetId } = decodeEvent(event);

  const identityId = getTextValue(did);
  const assetId = await getAssetId(rawAssetId, block);

  await AssetPreApproval.create({
    id: `${assetId}/${identityId}`,
    assetId,
    identityId,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const handleRemovePreApprovedAsset = async (event: SubstrateEvent): Promise<void> => {
  const { block } = extractArgs(event);
  const { did, assetId: rawAssetId } = decodeEvent(event);

  const identityId = getTextValue(did);
  const assetId = await getAssetId(rawAssetId, block);

  await AssetPreApproval.remove(`${assetId}/${identityId}`);
};

const getAssetAllowance = async (
  assetId: string,
  ownerId: string,
  spenderId: string,
  blockId: string,
  block: SubstrateEvent['block']
): Promise<AssetAllowance> => {
  await Promise.all([
    getOrCreateAccount(ownerId, blockId, block.timestamp),
    getOrCreateAccount(spenderId, blockId, block.timestamp),
  ]);

  const id = `${assetId}/${ownerId}/${spenderId}`;

  return (
    (await AssetAllowance.get(id)) ??
    AssetAllowance.create({
      id,
      assetId,
      ownerId,
      spenderId,
      amount: BigInt(0),
      totalSpent: BigInt(0),
      createdBlockId: blockId,
      updatedBlockId: blockId,
    })
  );
};

export const handleApproval = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block } = extractArgs(event);
  const {
    owner: rawOwner,
    spender: rawSpender,
    assetId: rawAssetId,
    amount: rawAmount,
  } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const allowance = await getAssetAllowance(
    assetId,
    getTextValue(rawOwner),
    getTextValue(rawSpender),
    blockId,
    block
  );

  allowance.amount = getBigIntValue(rawAmount);
  allowance.updatedBlockId = blockId;

  await allowance.save();
};

export const handleCreatedAssetTransfer = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, eventIdx, block, extrinsic, blockEventId } = extractArgs(event);
  const {
    assetId: rawAssetId,
    from: rawFrom,
    to: rawTo,
    amount: rawAmount,
    memo: rawMemo,
    pendingTransferId: rawPending,
  } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  await getAsset(assetId);

  // `pendingTransferId` is an InstructionId — the pending transfer is an already-modelled
  // Instruction, so this is a plain relation, no new state machine. Zero-pad it (D12) to match
  // the padded `Instruction.id`.
  const instructionId = rawPending?.isEmpty ? undefined : padNumericId(getTextValue(rawPending));

  await createAssetTransaction(
    blockId,
    eventIdx,
    block.timestamp,
    {
      assetId,
      fromHolder: accountHolder(undefined, getTextValue(rawFrom)),
      toHolder: accountHolder(undefined, getTextValue(rawTo)),
      amount: getBigIntValue(rawAmount),
      instructionId,
      instructionMemo: rawMemo?.isEmpty ? undefined : bytesToString(rawMemo),
    },
    blockEventId,
    EventIdEnum.CreatedAssetTransfer,
    extrinsic
  );
};

export const handleAllowanceSpent = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block } = extractArgs(event);
  const {
    owner: rawOwner,
    spender: rawSpender,
    assetId: rawAssetId,
    amountSpent: rawAmountSpent,
    remainingAllowance: rawRemaining,
  } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const allowance = await getAssetAllowance(
    assetId,
    getTextValue(rawOwner),
    getTextValue(rawSpender),
    blockId,
    block
  );

  // take the chain's own remaining value rather than subtracting — subtraction drifts if any
  // AllowanceSpent is ever missed or reordered
  allowance.amount = getBigIntValue(rawRemaining);
  allowance.totalSpent += getBigIntValue(rawAmountSpent);
  allowance.updatedBlockId = blockId;

  await allowance.save();
};
