import { Option, u64, U8aFixed } from '@polkadot/types-codec';
import { SubstrateEvent } from '@subql/types';
import { EventIdEnum, NftHolder } from '../../types';
import {
  bytesToString,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  getNftId,
  getPortfolioValue,
  getTextValue,
  serializeTicker,
} from '../../utils';
import { extractArgs, getAsset } from './common';
import { createAssetTransaction } from './mapAsset';

export const getNftHolder = async (
  ticker: string,
  did: string,
  blockId: string
): Promise<NftHolder> => {
  const id = `${ticker}/${did}`;

  let nftHolder = await NftHolder.get(id);

  if (!nftHolder) {
    nftHolder = NftHolder.create({
      id,
      identityId: did,
      assetId: ticker,
      nftIds: [],
      createdBlockId: blockId,
      updatedBlockId: blockId,
    });
    await nftHolder.save();
  }

  return nftHolder;
};

export const handleNftCollectionCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawTicker] = params;
  const ticker = serializeTicker(rawTicker);
  const asset = await await getAsset(ticker);

  asset.isNftCollection = true;
  asset.updatedBlockId = blockId;
  return asset.save();
};

export const handleNftPortfolioUpdates = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, eventIdx, block, extrinsic } = extractArgs(event);
  const [rawId, rawNftId, rawFromPortfolio, rawToPortfolio, rawUpdateReason] = params;

  let fromDid, fromPortfolioId;
  if (!rawFromPortfolio.isEmpty) {
    let fromPortfolioNumber;
    ({ identityId: fromDid, number: fromPortfolioNumber } = getPortfolioValue(rawFromPortfolio));
    fromPortfolioId = `${fromDid}/${fromPortfolioNumber}`;
  }
  let toDid, toPortfolioId;
  if (!rawToPortfolio.isEmpty) {
    let toPortfolioNumber;
    ({ identityId: toDid, number: toPortfolioNumber } = getPortfolioValue(rawToPortfolio));
    toPortfolioId = `${toDid}/${toPortfolioNumber}`;
  }

  const promises = [];

  const did = getTextValue(rawId);
  const reason = getFirstKeyFromJson(rawUpdateReason);
  const value = getFirstValueFromJson(rawUpdateReason);

  const { ticker, ids } = getNftId(rawNftId);

  const asset = await await getAsset(ticker);
  asset.updatedBlockId = blockId;

  let instructionId: string;
  let instructionMemo: string;

  let eventId: EventIdEnum;
  if (reason === 'issued') {
    eventId = EventIdEnum.IssuedNFT;
    asset.totalSupply += BigInt(ids.length);

    const nftHolder = await getNftHolder(ticker, did, blockId);
    nftHolder.nftIds.push(...ids);
    promises.push(nftHolder.save());
  } else if (reason === 'redeemed') {
    eventId = EventIdEnum.RedeemedNFT;
    asset.totalSupply -= BigInt(ids.length);

    const nftHolder = await getNftHolder(ticker, did, blockId);
    nftHolder.nftIds = nftHolder.nftIds.filter(heldId => !ids.includes(heldId));
    nftHolder.updatedBlockId = blockId;
    promises.push(nftHolder.save());
  } else if (reason === 'transferred' || reason === 'controllerTransfer') {
    const [fromHolder, toHolder] = await Promise.all([
      getNftHolder(ticker, fromDid, blockId),
      getNftHolder(ticker, toDid, blockId),
    ]);
    fromHolder.nftIds = fromHolder.nftIds.filter(id => !ids.includes(id));
    toHolder.nftIds.push(...ids);

    promises.push(fromHolder.save(), toHolder.save());

    asset.totalTransfers += BigInt(1);

    if (reason === 'transferred') {
      eventId = EventIdEnum.Transfer;
      const details = value as unknown as {
        readonly instructionId: Option<u64>;
        readonly instructionMemo: Option<U8aFixed>;
      };

      instructionId = getTextValue(details.instructionId);
      instructionMemo = bytesToString(details.instructionMemo);
    } else {
      eventId = EventIdEnum.ControllerTransfer;
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
        nftIds: ids.map(id => BigInt(id)),
        instructionId,
        instructionMemo,
      },
      eventId,
      extrinsic
    )
  );
  promises.push(asset.save());

  await Promise.all(promises);
};
