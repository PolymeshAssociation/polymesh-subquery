import { SubstrateBlock, SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { EventIdEnum, Portfolio } from '../../../types';
import {
  AssetHolderDetails,
  bytesToString,
  getAssetId,
  getBigIntValue,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  getNumberValue,
  getSignerAddress,
  getTextValue,
  rawPortfolioToAssetHolder,
} from '../../../utils';
import { createAssetTransaction } from '../assets/mapAsset';
import { Attributes, extractArgs } from '../common';
import { createIdentityIfNotExists } from './mapIdentities';

export const getPortfolio = async ({
  identityId,
  number,
}: Pick<Portfolio, 'identityId' | 'number'>): Promise<Portfolio> => {
  const portfolioId = `${identityId}/${number}`;

  const portfolio = await Portfolio.get(portfolioId);

  if (!portfolio) {
    throw new Error(`Portfolio number ${number} not found for DID ${identityId}`);
  }

  return portfolio;
};

export const createPortfolio = (
  attributes: Attributes<Portfolio>,
  blockId: string
): Promise<void> => {
  const { identityId, number } = attributes;
  return Portfolio.create({
    id: `${identityId}/${number}`,
    ...attributes,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

/**
 * Creates a Portfolio if not present.
 *
 * @note - WARNING: This is needed when an Instruction is created with a target Portfolio that doesn't exist. It should not be used unless necessary (i.e. before chain v7).
 */
export const createPortfolioIfNotExists = async (
  { identityId, number }: Pick<Portfolio, 'identityId' | 'number'>,
  blockId: string,
  eventId: EventIdEnum,
  eventIdx: number,
  block: SubstrateBlock,
  blockEventId: string
): Promise<void> => {
  await createIdentityIfNotExists(identityId, blockId, eventId, eventIdx, block, blockEventId);

  const portfolio = await Portfolio.get(`${identityId}/${number}`);
  if (!portfolio) {
    await createPortfolio(
      {
        identityId,
        number,
        name: '',
        eventIdx,
        createdEventId: blockEventId,
      },
      blockId
    );
  }
};

export const handlePortfolioCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, eventIdx, blockEventId } = extractArgs(event);
  const [rawOwnerDid, rawPortfolioNumber, rawName] = params;

  const ownerId = getTextValue(rawOwnerDid);
  const number = getNumberValue(rawPortfolioNumber);
  const name = bytesToString(rawName);

  const portfolio = await Portfolio.get(`${ownerId}/${number}`);
  if (portfolio) {
    // If the Portfolio was initially created by createPortfolioIfNotExists we update it as if it were newly created.
    portfolio.name = name;
    portfolio.eventIdx = eventIdx;
    portfolio.createdBlockId = blockId;
    portfolio.updatedBlockId = blockId;
    portfolio.createdEventId = blockEventId;

    await portfolio.save();
  } else {
    await createPortfolio(
      {
        identityId: ownerId,
        number,
        name,
        eventIdx,
        createdEventId: blockEventId,
      },
      blockId
    );
  }
};

export const handlePortfolioRenamed = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [rawOwnerDid, rawPortfolioNumber, rawName] = params;

  const ownerId = getTextValue(rawOwnerDid);
  const number = getNumberValue(rawPortfolioNumber);
  const name = bytesToString(rawName);

  const portfolio = await getPortfolio({ identityId: ownerId, number });

  portfolio.name = name;
  portfolio.updatedBlockId = blockId;

  await portfolio.save();
};

export const handlePortfolioDeleted = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block } = extractArgs(event);
  const [rawOwnerDid, rawPortfolioNumber] = params;

  const ownerId = getTextValue(rawOwnerDid);
  const number = getNumberValue(rawPortfolioNumber);

  const portfolio = await Portfolio.get(`${ownerId}/${number}`);
  portfolio.deletedAt = block.timestamp;
  portfolio.updatedBlockId = blockId;

  await portfolio.save();
};

export const handlePortfolioCustodianChanged = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId } = extractArgs(event);
  const [, rawPortfolio, rawCustodian] = params;

  const portfolioValue = rawPortfolioToAssetHolder(rawPortfolio);
  // ignore account custodian change
  if ('account' in portfolioValue) {
    return;
  }
  const custodian = getTextValue(rawCustodian);

  const portfolio = await getPortfolio(portfolioValue);
  portfolio.custodianId = custodian;
  portfolio.updatedBlockId = blockId;

  await portfolio.save();
};

/**
 * Handles the pre-6.0 `portfolio.MovedBetweenPortfolios` event.
 *
 * Folded into `AssetTransaction` (plan 05): every writer of the old `PortfolioMovement` entity —
 * this one, `handleFundsMovedBetweenPortfolios` and `settlement.FundsTransferred` — now goes
 * through the one shared writer, and the two tables provably did not overlap so nothing is
 * double counted.
 */
export const handlePortfolioMovement = async (event: SubstrateEvent): Promise<void> => {
  const { params, extrinsic, blockId, eventIdx, block, blockEventId } = extractArgs(event);
  const [, rawFromPortfolio, rawToPortfolio, rawAssetId, rawAmount, rawMemo] = params;

  const fromHolder = rawPortfolioToAssetHolder(rawFromPortfolio);
  const toHolder = rawPortfolioToAssetHolder(rawToPortfolio);
  // this pre-6.0 event only ever carried portfolio holders
  if ('account' in fromHolder || 'account' in toHolder) {
    return;
  }

  await createAssetTransaction(
    blockId,
    eventIdx,
    block.timestamp,
    {
      assetId: await getAssetId(rawAssetId, block),
      fromHolder,
      toHolder,
      amount: getBigIntValue(rawAmount),
      memo: bytesToString(rawMemo),
      address: getSignerAddress(extrinsic),
    },
    blockEventId,
    EventIdEnum.MovedBetweenPortfolios,
    extrinsic
  );
};

type AssetMovementArgs = {
  blockEventId: string;
  blockId: string;
  eventIdx: number;
  eventId: EventIdEnum;
  address: string;
  fromHolder: AssetHolderDetails;
  toHolder: AssetHolderDetails;
  assetType: string;
  fundDescription: unknown;
  memo: string | undefined;
  block: SubstrateBlock;
  extrinsic?: SubstrateExtrinsic;
};

/**
 * Shared writer for the fund-description movement events (`FundsMovedBetweenPortfolios`,
 * `settlement.FundsTransferred`). Writes one `AssetTransaction` row; `createAssetTransaction`
 * classifies `isInternalTransfer` from the two holders.
 */
export const mapAssetMovement = async ({
  blockEventId,
  blockId,
  eventIdx,
  eventId,
  address,
  fromHolder,
  toHolder,
  assetType,
  fundDescription,
  memo,
  block,
  extrinsic,
}: AssetMovementArgs): Promise<void> => {
  let assetId: string;
  let amount: bigint | undefined;
  let nftIds: bigint[] | undefined;

  if (assetType === 'fungible') {
    const description = fundDescription as { ticker?: string; assetId?: string; amount: number };
    assetId = await getAssetId(description.ticker ?? description.assetId, block);
    amount = BigInt(description.amount);
  } else if (assetType === 'nonFungible') {
    const description = fundDescription as { ticker?: string; assetId?: string; ids: number[] };
    assetId = await getAssetId(description.ticker ?? description.assetId, block);
    nftIds = description.ids.map(BigInt);
  } else {
    return;
  }

  await createAssetTransaction(
    blockId,
    eventIdx,
    block.timestamp,
    { assetId, fromHolder, toHolder, amount, nftIds, memo, address },
    blockEventId,
    eventId,
    extrinsic
  );
};

export const handleFundsMovedBetweenPortfolios = async (event: SubstrateEvent): Promise<void> => {
  const { params, extrinsic, blockId, eventIdx, block, blockEventId } = extractArgs(event);
  const [, rawFromPortfolio, rawToPortfolio, rawFundDescription, rawMemo] = params;

  await mapAssetMovement({
    blockEventId,
    blockId,
    eventIdx,
    eventId: EventIdEnum.FundsMovedBetweenPortfolios,
    address: getSignerAddress(extrinsic),
    fromHolder: rawPortfolioToAssetHolder(rawFromPortfolio),
    toHolder: rawPortfolioToAssetHolder(rawToPortfolio),
    assetType: getFirstKeyFromJson(rawFundDescription),
    fundDescription: getFirstValueFromJson(rawFundDescription),
    memo: bytesToString(rawMemo),
    block,
    extrinsic,
  });
};

/**
 * `portfolio.FungibleTokensMovedBetweenPortfolios` — a v5.4.3-only event (defect A8). Emitted
 * from `unchecked_move_funds` and removed at v6.0.0; `MovedBetweenPortfolios` is not emitted
 * alongside it, so without this the movement is not indexed at all. Measured: 0 on mainnet,
 * 0 on testnet — registered for completeness and testnet parity.
 */
export const handleFungibleTokensMovedBetweenPortfolios = async (
  event: SubstrateEvent
): Promise<void> => {
  const { extrinsic, blockId, eventIdx, block, blockEventId } = extractArgs(event);
  const {
    fromPortfolio: rawFrom,
    toPortfolio: rawTo,
    ticker: rawTicker,
    amount: rawAmount,
    memo: rawMemo,
  } = decodeEvent(event);

  const fromHolder = rawPortfolioToAssetHolder(rawFrom);
  const toHolder = rawPortfolioToAssetHolder(rawTo);
  if ('account' in fromHolder || 'account' in toHolder) {
    return;
  }

  await createAssetTransaction(
    blockId,
    eventIdx,
    block.timestamp,
    {
      assetId: await getAssetId(rawTicker, block),
      fromHolder,
      toHolder,
      amount: getBigIntValue(rawAmount),
      memo: bytesToString(rawMemo),
      address: getSignerAddress(extrinsic),
    },
    blockEventId,
    EventIdEnum.FungibleTokensMovedBetweenPortfolios,
    extrinsic
  );
};

/**
 * `portfolio.NFTsMovedBetweenPortfolios` — the non-fungible sibling of the above, 5 args
 * (an `NFTs` collection rather than a ticker/amount pair). Measured: 0 on mainnet, 1 on testnet
 * (block 7,786,536).
 */
export const handleNftsMovedBetweenPortfolios = async (event: SubstrateEvent): Promise<void> => {
  const { extrinsic, blockId, eventIdx, block, blockEventId } = extractArgs(event);
  const {
    fromPortfolio: rawFrom,
    toPortfolio: rawTo,
    nfts: rawNfts,
    memo: rawMemo,
  } = decodeEvent(event);

  const fromHolder = rawPortfolioToAssetHolder(rawFrom);
  const toHolder = rawPortfolioToAssetHolder(rawTo);
  if ('account' in fromHolder || 'account' in toHolder) {
    return;
  }

  const nfts = rawNfts.toJSON() as { ticker?: string; assetId?: string; ids: number[] };

  await createAssetTransaction(
    blockId,
    eventIdx,
    block.timestamp,
    {
      assetId: await getAssetId(nfts.ticker ?? nfts.assetId, block),
      fromHolder,
      toHolder,
      nftIds: nfts.ids.map(BigInt),
      memo: bytesToString(rawMemo),
      address: getSignerAddress(extrinsic),
    },
    blockEventId,
    EventIdEnum.NFTsMovedBetweenPortfolios,
    extrinsic
  );
};
