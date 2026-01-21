import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import {
  DartConfidentialAccount,
  DartConfidentialAccountAsset,
  DartConfidentialAccountCurveRoot,
  DartConfidentialAccountStateLeaf,
  DartConfidentialAsset,
  DartConfidentialAssetCurveRoot,
  DartConfidentialAssetMint,
  DartConfidentialAssetStateLeaf,
  DartConfidentialAssetUpdate,
  DartConfidentialEncryptionKey,
  DartConfidentialFeeAccount,
  DartConfidentialFeeAccountCurveRoot,
  DartConfidentialFeeAccountDeposit,
  DartConfidentialFeeAccountStateLeaf,
  DartConfidentialFeeAccountWithdraw,
  DartConfidentialLegAction,
  DartConfidentialRelayerBatch,
  DartConfidentialSettlement,
  DartConfidentialSettlementStatus,
  DartLegActionEnum,
} from '../../../types';
import {
  bytesToString,
  getBigIntValue,
  getErrorDetails,
  getNumberValue,
  getStringArrayValue,
  getTextValue,
} from '../../../utils/common';
import { extractArgs } from '../common';

/**
 * Safely parse a Codec representing a JSON array of strings.
 * Falls back to an empty array if parsing fails.
 */
const parseStringArray = (item: Codec): string[] => {
  try {
    return getStringArrayValue(item) || [];
  } catch {
    return [];
  }
};

/**
 * Parse a Codec that could be an array of bytes/strings and normalize to string[].
 * Attempts to decode bytes to string; otherwise stringifies JSON values.
 * Falls back to a single-element array with string content when parsing fails.
 */
const parseBytesArray = (item: Codec): string[] => {
  const json = item.toJSON();
  if (Array.isArray(json)) {
    return json.map(val => {
      if (typeof val === 'string') {
        try {
          return bytesToString(api.registry.createType('Bytes', val) as unknown as Codec) || val;
        } catch {
          return val;
        }
      }
      return JSON.stringify(val);
    });
  }

  try {
    return parseStringArray(item);
  } catch {
    const text = getTextValue(item);
    return text ? [text] : [];
  }
};

/**
 * Normalize a Result-like Codec into a string.
 * Returns 'Ok' when Ok present; stringifies Err; otherwise returns text value.
 */
const normalizeBatchResult = (item: Codec): string => {
  const json = item.toJSON();
  if (json && typeof json === 'object') {
    if ('Ok' in json || 'ok' in json) {
      return 'Ok';
    }
    if ('Err' in json || 'err' in json) {
      return JSON.stringify(json.Err ?? json.err);
    }
  }
  return getTextValue(item);
};

const ensureEncryptionKey = async (
  encryptionKey: string,
  callerId: string,
  eventIdx: number,
  blockId: string,
  blockEventId: string
): Promise<void> => {
  const existing = await DartConfidentialEncryptionKey.get(encryptionKey);
  if (existing) {
    existing.callerId = callerId;
    existing.eventIdx = eventIdx;
    existing.updatedBlockId = blockId;
    await existing.save();
    return;
  }

  await DartConfidentialEncryptionKey.create({
    id: encryptionKey,
    callerId,
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};

const ensureAccount = async (
  accountId: string,
  callerId: string,
  encryptionKey: string,
  eventIdx: number,
  blockId: string,
  blockEventId: string
): Promise<DartConfidentialAccount> => {
  const existing = await DartConfidentialAccount.get(accountId);
  if (existing) {
    existing.callerId = callerId;
    existing.encryptionKey = encryptionKey;
    existing.eventIdx = eventIdx;
    existing.updatedBlockId = blockId;
    await existing.save();
    return existing;
  }

  const created = DartConfidentialAccount.create({
    id: accountId,
    callerId,
    encryptionKey,
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  });

  await created.save();
  return created;
};

type AssetArgs = {
  assetId: string;
  callerId: string;
  mediators: string[];
  auditors: string[];
  name: string;
  symbol: string;
  decimals: number;
  data?: string;
  eventIdx: number;
  blockId: string;
  blockEventId: string;
};

const ensureAsset = async ({
  assetId,
  callerId,
  mediators,
  auditors,
  name,
  symbol,
  decimals,
  data,
  eventIdx,
  blockId,
  blockEventId,
}: AssetArgs): Promise<DartConfidentialAsset> => {
  const existing = await DartConfidentialAsset.get(assetId);
  if (existing) {
    existing.callerId = callerId;
    existing.mediators = mediators;
    existing.auditors = auditors;
    existing.name = name;
    existing.symbol = symbol;
    existing.decimals = decimals;
    existing.data = data;
    existing.eventIdx = eventIdx;
    existing.updatedBlockId = blockId;
    await existing.save();
    return existing;
  }

  const created = DartConfidentialAsset.create({
    id: assetId,
    assetId: Number(assetId),
    callerId,
    mediators,
    auditors,
    name,
    symbol,
    decimals,
    data,
    totalSupply: BigInt(0),
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  });

  await created.save();
  return created;
};

export const handleDartEncryptionKeyRegistered = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [rawCallerDid, rawEncryptionKey] = params;

  const callerId = getTextValue(rawCallerDid);
  const encryptionKey = getTextValue(rawEncryptionKey);

  if (!encryptionKey || !callerId) {
    return;
  }

  await ensureEncryptionKey(encryptionKey, callerId, eventIdx, blockId, blockEventId);
};

export const handleDartAccountRegistered = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [rawCallerDid, rawAccount, rawEncryptionKey] = params;

  const callerId = getTextValue(rawCallerDid);
  const accountId = getTextValue(rawAccount);
  const encryptionKey = getTextValue(rawEncryptionKey);

  if (!callerId || !accountId || !encryptionKey) {
    return;
  }

  await ensureEncryptionKey(encryptionKey, callerId, eventIdx, blockId, blockEventId);
  await ensureAccount(accountId, callerId, encryptionKey, eventIdx, blockId, blockEventId);
};

export const handleDartAccountAssetRegistered = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [rawCallerDid, rawAccount, rawAssetId] = params;

  const callerId = getTextValue(rawCallerDid);
  const accountId = getTextValue(rawAccount);
  const assetId = getNumberValue(rawAssetId);

  if (!callerId || !accountId) {
    return;
  }

  const account = await DartConfidentialAccount.get(accountId);
  if (!account) {
    return;
  }

  const id = `${accountId}/${assetId}`;
  const existing = await DartConfidentialAccountAsset.get(id);

  if (existing) {
    existing.callerId = callerId;
    existing.eventIdx = eventIdx;
    existing.updatedBlockId = blockId;
    await existing.save();
    return;
  }

  await DartConfidentialAccountAsset.create({
    id,
    accountId,
    assetId,
    callerId,
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};

export const handleDartAccountCurveTreeRootUpdated = async (
  event: SubstrateEvent
): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [root] = params;

  await DartConfidentialAccountCurveRoot.create({
    id: blockEventId,
    root: getTextValue(root),
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};

export const handleDartAccountStateLeafInserted = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [leafIndex, commitment] = params;

  await DartConfidentialAccountStateLeaf.create({
    id: blockEventId,
    leafIndex: getBigIntValue(leafIndex),
    commitment: getTextValue(commitment),
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};

export const handleDartAssetCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [
    rawCallerDid,
    rawAssetId,
    rawMediators,
    rawAuditors,
    rawName,
    rawSymbol,
    rawDecimals,
    rawData,
  ] = params;

  const callerId = getTextValue(rawCallerDid);
  const assetIdNumber = getNumberValue(rawAssetId);
  const assetId = assetIdNumber?.toString();
  if (!callerId || assetId === undefined) {
    return;
  }

  const mediators = parseStringArray(rawMediators);
  const auditors = parseStringArray(rawAuditors);
  const name = getTextValue(rawName) || '';
  const symbol = getTextValue(rawSymbol) || '';
  const decimals = getNumberValue(rawDecimals) || 0;
  const data = bytesToString(rawData);

  await ensureAsset({
    assetId,
    callerId,
    mediators,
    auditors,
    name,
    symbol,
    decimals,
    data,
    eventIdx,
    blockId,
    blockEventId,
  });
};

export const handleDartAssetUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [rawCallerDid, rawAssetId, rawMediators, rawAuditors] = params;

  const callerId = getTextValue(rawCallerDid);
  const assetIdNumber = getNumberValue(rawAssetId);
  const assetId = assetIdNumber?.toString();

  if (!callerId || assetId === undefined) {
    return;
  }

  const mediators = parseStringArray(rawMediators);
  const auditors = parseStringArray(rawAuditors);

  const asset = await DartConfidentialAsset.get(assetId);
  if (asset) {
    asset.mediators = mediators;
    asset.auditors = auditors;
    asset.callerId = callerId;
    asset.eventIdx = eventIdx;
    asset.updatedBlockId = blockId;
    await asset.save();
  } else {
    await ensureAsset({
      assetId,
      callerId,
      mediators,
      auditors,
      name: '',
      symbol: '',
      decimals: 0,
      data: undefined,
      eventIdx,
      blockId,
      blockEventId,
    });
  }

  await DartConfidentialAssetUpdate.create({
    id: blockEventId,
    assetId,
    mediators,
    auditors,
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};

export const handleDartAssetCurveTreeRootUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [root] = params;

  await DartConfidentialAssetCurveRoot.create({
    id: blockEventId,
    root: getTextValue(root),
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};

export const handleDartAssetStateLeafUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [leafIndex, leaf] = params;

  await DartConfidentialAssetStateLeaf.create({
    id: blockEventId,
    leafIndex: getBigIntValue(leafIndex),
    leaf: getTextValue(leaf),
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};

export const handleDartAssetMinted = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [rawCallerDid, rawAssetId, rawAmount, rawTotalSupply, rawAccount] = params;

  const callerId = getTextValue(rawCallerDid);
  const assetIdNumber = getNumberValue(rawAssetId);
  const assetId = assetIdNumber?.toString();

  if (!callerId || assetId === undefined) {
    return;
  }

  const amount = getBigIntValue(rawAmount);
  const totalSupply = getBigIntValue(rawTotalSupply);
  const accountId = getTextValue(rawAccount);

  const asset =
    (await DartConfidentialAsset.get(assetId)) ||
    (await ensureAsset({
      assetId,
      callerId,
      mediators: [],
      auditors: [],
      name: '',
      symbol: '',
      decimals: 0,
      data: undefined,
      eventIdx,
      blockId,
      blockEventId,
    }));

  asset.totalSupply = totalSupply;
  asset.eventIdx = eventIdx;
  asset.updatedBlockId = blockId;
  await asset.save();

  await DartConfidentialAssetMint.create({
    id: blockEventId,
    assetId,
    accountId,
    callerId,
    amount,
    totalSupply,
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};

export const handleDartFeeAccountCurveTreeRootUpdated = async (
  event: SubstrateEvent
): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [root] = params;

  await DartConfidentialFeeAccountCurveRoot.create({
    id: blockEventId,
    root: getTextValue(root),
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};

export const handleDartFeeAccountStateLeafInserted = async (
  event: SubstrateEvent
): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [leafIndex, commitment] = params;

  await DartConfidentialFeeAccountStateLeaf.create({
    id: blockEventId,
    leafIndex: getBigIntValue(leafIndex),
    commitment: getTextValue(commitment),
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};

export const handleDartFeeAccountDeposited = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [sender, amount] = params;

  await DartConfidentialFeeAccountDeposit.create({
    id: blockEventId,
    sender: getTextValue(sender),
    amount: getBigIntValue(amount),
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};

export const handleDartFeeAccountWithdrawn = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [receiver, amount] = params;

  await DartConfidentialFeeAccountWithdraw.create({
    id: blockEventId,
    receiver: getTextValue(receiver),
    amount: getBigIntValue(amount),
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};

export const handleDartFeeAccountUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [rawCallerDid, rawAccount, rawIsRegistration, rawAmount] = params;

  const callerId = getTextValue(rawCallerDid);
  const accountId = getTextValue(rawAccount);

  if (!callerId || !accountId) {
    return;
  }

  const isRegistration = JSON.parse(getTextValue(rawIsRegistration) || 'false');
  const amount = getBigIntValue(rawAmount);

  const existing = await DartConfidentialFeeAccount.get(accountId);
  if (existing) {
    existing.callerId = callerId;
    existing.isRegistration = isRegistration;
    existing.amount = amount;
    existing.eventIdx = eventIdx;
    existing.updatedBlockId = blockId;
    await existing.save();
    return;
  }

  await DartConfidentialFeeAccount.create({
    id: accountId,
    account: accountId,
    callerId,
    isRegistration,
    amount,
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};

const saveLegAction = async (
  legRef: string,
  action: DartLegActionEnum,
  eventIdx: number,
  blockId: string,
  blockEventId: string,
  keyIndex?: number
): Promise<void> => {
  if (!legRef) {
    return;
  }

  await DartConfidentialLegAction.create({
    id: blockEventId,
    legRef,
    action,
    keyIndex,
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};

export const handleDartMediatorAffirmed = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [legRef, keyIndex] = params;
  await saveLegAction(
    getTextValue(legRef),
    DartLegActionEnum.MediatorAffirmed,
    eventIdx,
    blockId,
    blockEventId,
    getNumberValue(keyIndex)
  );
};

export const handleDartMediatorRejected = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [legRef, keyIndex] = params;
  await saveLegAction(
    getTextValue(legRef),
    DartLegActionEnum.MediatorRejected,
    eventIdx,
    blockId,
    blockEventId,
    getNumberValue(keyIndex)
  );
};

export const handleDartReceiverAffirmed = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [legRef] = params;
  await saveLegAction(
    getTextValue(legRef),
    DartLegActionEnum.ReceiverAffirmed,
    eventIdx,
    blockId,
    blockEventId
  );
};

export const handleDartReceiverClaimed = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [legRef] = params;
  await saveLegAction(
    getTextValue(legRef),
    DartLegActionEnum.ReceiverClaimed,
    eventIdx,
    blockId,
    blockEventId
  );
};

export const handleDartSenderAffirmed = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [legRef] = params;
  await saveLegAction(
    getTextValue(legRef),
    DartLegActionEnum.SenderAffirmed,
    eventIdx,
    blockId,
    blockEventId
  );
};

export const handleDartSenderCounterUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [legRef] = params;
  await saveLegAction(
    getTextValue(legRef),
    DartLegActionEnum.SenderCounterUpdated,
    eventIdx,
    blockId,
    blockEventId
  );
};

export const handleDartSenderReverted = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [legRef] = params;
  await saveLegAction(
    getTextValue(legRef),
    DartLegActionEnum.SenderReverted,
    eventIdx,
    blockId,
    blockEventId
  );
};

export const handleDartRelayerBatchedProofs = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [relayer, amount, batchHash, batchResult] = params;

  let resultText = normalizeBatchResult(batchResult);
  if (!resultText) {
    try {
      resultText = JSON.stringify(getErrorDetails(batchResult));
    } catch {
      resultText = undefined;
    }
  }

  await DartConfidentialRelayerBatch.create({
    id: blockEventId,
    relayer: getTextValue(relayer),
    amount: getBigIntValue(amount),
    batchHash: getTextValue(batchHash),
    batchResult: resultText,
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  }).save();
};

export const handleDartSettlementCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [settlementRef, memo, assetRootBlock, legsCodec] = params;

  const id = getTextValue(settlementRef);
  if (!id) {
    return;
  }

  const legs = parseBytesArray(legsCodec);

  const settlement = DartConfidentialSettlement.create({
    id,
    settlementRef: id,
    memo: bytesToString(memo),
    assetRootBlock: getNumberValue(assetRootBlock),
    legs,
    status: undefined,
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  });

  await settlement.save();
};

export const handleDartSettlementStatusUpdated = async (event: SubstrateEvent): Promise<void> => {
  const { params, eventIdx, blockId, blockEventId } = extractArgs(event);
  const [settlementRef, statusCodec] = params;

  const id = getTextValue(settlementRef);
  if (!id) {
    return;
  }

  const status = getTextValue(statusCodec);

  const settlement =
    (await DartConfidentialSettlement.get(id)) ||
    DartConfidentialSettlement.create({
      id,
      settlementRef: id,
      memo: undefined,
      assetRootBlock: 0,
      legs: [],
      status,
      eventIdx,
      createdBlockId: blockId,
      updatedBlockId: blockId,
      createdEventId: blockEventId,
    });

  settlement.status = status;
  settlement.eventIdx = eventIdx;
  settlement.updatedBlockId = blockId;

  const statusHistory = DartConfidentialSettlementStatus.create({
    id: blockEventId,
    settlementId: id,
    status,
    eventIdx,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    createdEventId: blockEventId,
  });

  await Promise.all([settlement.save(), statusHistory.save()]);
};
