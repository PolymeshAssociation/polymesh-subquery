import { capitalizeFirstLetter, getFirstValueFromJson } from './../../../utils/common';
import { Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import { Investment, RaisingAssetTypeEnum, Sto, StoStatus } from '../../../types';
import {
  coerceHexToString,
  getAssetId,
  getAssetIdWithTicker,
  getBigIntValue,
  getDateValue,
  getFirstKeyFromJson,
  getFundraiserDetails,
  getNumberValue,
  getTextValue,
  is7Dot3Chain,
} from '../../../utils';
import { extractArgs } from '../common';

const getOfferingAsset = (
  block: SubstrateBlock,
  params: Codec[],
  extrinsic?: SubstrateExtrinsic
): Promise<string> => {
  const rawOfferingAsset = is7Dot3Chain(block)
    ? params[1]
    : (extrinsic?.extrinsic.args[0] as unknown as Codec);
  return getAssetId(rawOfferingAsset, block);
};

export const handleFundraiserCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block } = extractArgs(event);
  let rawStoId: Codec;
  let rawStoName: Codec;
  let rawFundraiserDetails: Codec;

  if (is7Dot3Chain(block)) {
    [, , , rawStoId, rawStoName, rawFundraiserDetails] = params;
  } else {
    [, rawStoId, rawStoName, rawFundraiserDetails] = params;
  }

  const fundraiserDetails = await getFundraiserDetails(rawFundraiserDetails, block);
  const stoId = getNumberValue(rawStoId);
  const name = coerceHexToString(getTextValue(rawStoName));

  await Sto.create({
    id: `${fundraiserDetails.offeringAssetId}/${stoId}`,
    stoId,
    name,
    ...fundraiserDetails,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

export const handleStoFrozen = async (event: SubstrateEvent): Promise<void> => {
  await handleFundraiserStatus(event, StoStatus.Frozen);
};

export const handleStoUnfrozen = async (event: SubstrateEvent): Promise<void> => {
  await handleFundraiserStatus(event, StoStatus.Live);
};

export const handleStoClosed = async (event: SubstrateEvent): Promise<void> => {
  await handleFundraiserStatus(event, StoStatus.Closed);
};

export const handleFundraiserOffchainFundingEnabled = async (
  event: SubstrateEvent
): Promise<void> => {
  const { params, block, blockId } = extractArgs(event);
  const [, rawOfferingAsset, rawStoId, rawOffChainTicker] = params;
  const offeringAssetId = await getAssetId(rawOfferingAsset, block);
  const stoId = getNumberValue(rawStoId);
  const offChainTicker = coerceHexToString(getTextValue(rawOffChainTicker));

  const sto = await Sto.get(`${offeringAssetId}/${stoId}`);

  if (sto) {
    sto.offChainFundingEnabled = true;
    sto.offChainFundingToken = offChainTicker;
    sto.updatedBlockId = blockId;
    await sto.save();
  }
};

const handleFundraiserStatus = async (event: SubstrateEvent, status: StoStatus): Promise<void> => {
  const { params, extrinsic, block, blockId } = extractArgs(event);
  const [, rawStoId] = params;

  const offeringAssetId = await getOfferingAsset(block, params, extrinsic);
  const stoId = getNumberValue(rawStoId);

  const sto = await Sto.get(`${offeringAssetId}/${stoId}`);

  if (!sto) {
    throw new Error(`Sto with id ${offeringAssetId}/${stoId} was not found`);
  }

  sto.status = status;
  if (status === StoStatus.Closed) {
    // if sto is closed before the configured end time, status should be set as `ClosedEarly`
    if (sto.end && block.timestamp < sto.end) {
      sto.status = StoStatus.ClosedEarly;
    }
  }
  sto.updatedBlockId = blockId;
  await sto.save();
};

export const handleFundraiserWindowModified = async (event: SubstrateEvent): Promise<void> => {
  const { params, extrinsic, blockId, block } = extractArgs(event);
  const offeringAssetId = await getOfferingAsset(block, params, extrinsic);

  let rawStoId: Codec;
  let rawStart: Codec;
  let rawEnd: Codec;

  if (is7Dot3Chain(block)) {
    [, , rawStoId, , , rawStart, rawEnd] = params;
  } else {
    [, rawStoId, , , rawStart, rawEnd] = params;
  }

  const stoId = getNumberValue(rawStoId);

  const sto = await Sto.get(`${offeringAssetId}/${stoId}`);

  if (sto) {
    sto.start = getDateValue(rawStart);
    sto.end = getDateValue(rawEnd);
    sto.updatedBlockId = blockId;
    await sto.save();
  }
};

export const handleInvested = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block, blockEventId } = extractArgs(event);

  let rawInvestor: Codec;
  let rawStoId: Codec;
  let rawOfferingAsset: Codec;
  let rawRaisingAsset: Codec;
  let rawOfferingTokenAmount: Codec;
  let rawRaiseTokenAmount: Codec;

  let offeringAssetId: string;
  let offeringToken: string;
  let raisingAssetId: string;
  let raiseToken: string;
  let raisingAssetType: RaisingAssetTypeEnum;

  if (is7Dot3Chain(block)) {
    [rawInvestor, rawOfferingAsset, rawStoId, , rawOfferingTokenAmount, rawRaiseTokenAmount] =
      params;

    ({ assetId: offeringAssetId, ticker: offeringToken } = await getAssetIdWithTicker(
      rawOfferingAsset,
      block
    ));

    const rawFundingAssetDetails = JSON.parse(params[3].toString());

    const assetType = capitalizeFirstLetter(getFirstKeyFromJson(rawFundingAssetDetails));
    const rawFundingAsset = getFirstValueFromJson(rawFundingAssetDetails);

    if (assetType === RaisingAssetTypeEnum.OnChain) {
      ({ assetId: raisingAssetId, ticker: raiseToken } = await getAssetIdWithTicker(
        rawFundingAsset,
        block
      ));
      raisingAssetType = RaisingAssetTypeEnum.OnChain;
    } else {
      const offChainTicker = coerceHexToString(rawFundingAsset);
      raisingAssetId = offChainTicker;
      raiseToken = offChainTicker;
      raisingAssetType = RaisingAssetTypeEnum.OffChain;
    }
  } else {
    [
      rawInvestor,
      rawStoId,
      rawOfferingAsset,
      rawRaisingAsset,
      rawOfferingTokenAmount,
      rawRaiseTokenAmount,
    ] = params;

    [
      { assetId: raisingAssetId, ticker: raiseToken },
      { assetId: offeringAssetId, ticker: offeringToken },
    ] = await Promise.all([
      getAssetIdWithTicker(rawRaisingAsset, block),
      getAssetIdWithTicker(rawOfferingAsset, block),
    ]);
    raisingAssetType = RaisingAssetTypeEnum.OnChain;
  }

  await Investment.create({
    id: blockEventId,
    investorId: getTextValue(rawInvestor),
    stoId: getNumberValue(rawStoId),
    offeringAssetId,
    offeringToken,
    raisingAssetId,
    raiseToken,
    raisingAssetType,
    offeringTokenAmount: getBigIntValue(rawOfferingTokenAmount),
    raiseTokenAmount: getBigIntValue(rawRaiseTokenAmount),
    datetime: block.timestamp,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};
