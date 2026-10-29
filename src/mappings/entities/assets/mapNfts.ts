import { Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { AnomalyKind, Asset, EventIdEnum, HolderKind, Nft, NftApproval } from '../../../types';
import {
  AssetHolderDetails,
  getAssetId,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  getNftId,
  getNumberValue,
  getHoldingId,
  getTextValue,
  padId,
  padNumericId,
  portfolioHolder,
  rawAssetHolderToAssetHolder,
} from '../../../utils';
import { recordAnomaly } from '../../../utils/anomaly';
import { blockEvents } from '../../../utils/blockEvents';
import { extractArgs, getAsset } from './../common';
import { applyNftCountDelta, createAssetTransaction, getHolding } from './mapAsset';
import { nftApprovalId } from './mapNftApprovals';
import { memoText } from '../../../utils/text';
import { isObject } from '../../../utils/codec';

const nftRowId = (assetId: string, nftId: number): string => `${assetId}/${padId(String(nftId))}`;

const locationOf = (
  assetId: string,
  holder: AssetHolderDetails | undefined
): Pick<Nft, 'holdingId'> => ({
  holdingId: holder ? getHoldingId(assetId, holder) : undefined,
});

/** Builds one token's row; unsaved — callers collect these and `bulkCreateNfts` them in one call. */
const mintNft = (
  assetId: string,
  nftId: number,
  holder: AssetHolderDetails,
  blockEventId: string
): Nft =>
  Nft.create({
    id: nftRowId(assetId, nftId),
    assetId,
    nftId: BigInt(nftId),
    ...locationOf(assetId, holder),
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  });

/**
 * Moves a token to a new location. A miss means the row predates the seed — reconciliation covers
 * it. Unsaved — the caller collects these (dropping the misses) and `bulkUpdateNfts` them in one
 * call.
 */
const moveNft = async (
  assetId: string,
  nftId: number,
  holder: AssetHolderDetails | undefined,
  blockEventId: string
): Promise<Nft | undefined> => {
  const nft = await Nft.get(nftRowId(assetId, nftId));
  if (!nft) {
    return undefined;
  }
  Object.assign(nft, locationOf(assetId, holder));
  nft.updatedEventId = blockEventId;
  return nft;
};

/**
 * Marks a token burned. The row stays queryable; `burnedEventId: { isNull: true }` filters it out.
 * Unsaved — see `moveNft`.
 */
const burnNft = async (
  assetId: string,
  nftId: number,
  blockEventId: string
): Promise<Nft | undefined> => {
  const nft = await Nft.get(nftRowId(assetId, nftId));
  if (!nft) {
    return undefined;
  }
  nft.burnedEventId = blockEventId;
  // out of every holding, so a holding's `nfts` are exactly what it holds
  nft.holdingId = undefined;
  nft.updatedEventId = blockEventId;
  return nft;
};

/**
 * Clears the per-token approvals on tokens leaving an account holder.
 *
 * The chain drops a per-token approval whenever the token leaves the account that held it, and emits
 * nothing for that — `NFTApprovalSpent` covers only the case where the approved spender did the
 * moving. Only an account holder can grant one, which is also the chain's own reason for clearing
 * them only there: a token leaving a portfolio has nothing to clear, and neither does any move made
 * before account-level holders existed, so the old high-volume NFT ranges pay nothing for this.
 */
const clearTokenApprovals = (
  assetId: string,
  ids: number[],
  fromHolder: AssetHolderDetails | undefined,
  promises: Promise<void>[]
): void => {
  if (fromHolder?.holderKind !== HolderKind.Account) {
    return;
  }

  ids.forEach(nftId => promises.push(NftApproval.remove(nftApprovalId(assetId, nftId))));
};

/** One round trip for N minted tokens instead of N individual inserts. */
const bulkCreateNfts = (nfts: Nft[]): Promise<void> =>
  nfts.length > 0 ? store.bulkCreate('Nft', nfts) : Promise.resolve();

/** One round trip for N updated tokens instead of N individual updates; drops `moveNft`/`burnNft` misses. */
const bulkUpdateNfts = (nfts: (Nft | undefined)[]): Promise<void> => {
  const rows = nfts.filter((nft): nft is Nft => nft !== undefined);
  return rows.length > 0 ? store.bulkUpdate('Nft', rows) : Promise.resolve();
};

const adjustNftCount = async (
  assetId: string,
  holder: AssetHolderDetails | undefined,
  blockEventId: string,
  delta: number,
  promises: Promise<void>[]
): Promise<void> => {
  if (!holder) {
    return;
  }
  const holding = await getHolding(assetId, holder, blockEventId);
  holding.nftCount += delta;
  holding.updatedEventId = blockEventId;
  promises.push(holding.save());
};

/**
 * Moves NFTs between two holders of one identity (portfolios, or v8 accounts), which the chain
 * reports only as a movement: each token's row and both holders' counts move, approvals on tokens
 * leaving an account are cleared, and the identity's rollup does not change.
 */
export const moveNftsWithinIdentity = async (
  assetId: string,
  ids: number[],
  from: AssetHolderDetails,
  to: AssetHolderDetails,
  blockEventId: string
): Promise<void> => {
  const promises: Promise<void>[] = [];
  const moved = await Promise.all(ids.map(nftId => moveNft(assetId, nftId, to, blockEventId)));

  await adjustNftCount(assetId, from, blockEventId, -ids.length, promises);
  await adjustNftCount(assetId, to, blockEventId, ids.length, promises);
  clearTokenApprovals(assetId, ids, from, promises);
  promises.push(bulkUpdateNfts(moved));

  await Promise.all(promises);
};

/**
 * The instruction a `transferred` update reason names, from the reason's JSON: the instruction id
 * as a number (or hex text once it outgrows one) and the memo as hex, either of which may be null.
 */
const transferDetails = (value: unknown): { instructionId?: string; instructionMemo?: string } => {
  if (!isObject(value)) {
    throw new TypeError(`a transferred update reason carried ${JSON.stringify(value)}`);
  }
  const { instructionId, instructionMemo } = value;

  return {
    instructionId:
      typeof instructionId === 'number' || typeof instructionId === 'string'
        ? String(instructionId).trim() || undefined
        : undefined,
    instructionMemo: typeof instructionMemo === 'string' ? instructionMemo : undefined,
  };
};

export const handleNftCollectionCreated = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { assetId: rawAssetId } = decodeEvent(event);
  const assetId = await getAssetId(rawAssetId, block);
  const asset = await getAsset(assetId, event);

  asset.isNftCollection = true;
  asset.updatedEventId = blockEventId;
  return asset.save();
};

interface NftSupplyChange {
  asset: Asset;
  holder: AssetHolderDetails;
  ids: number[];
  blockEventId: string;
  promises: Promise<void>[];
}

/** Mints tokens into `holder`: supply, the identity rollup, one row per token, and the holding count. */
const issueNfts = async ({
  asset,
  holder,
  ids,
  blockEventId,
  promises,
}: NftSupplyChange): Promise<void> => {
  asset.totalSupply += BigInt(ids.length);

  // per-token rows — one bulk insert instead of N round trips
  promises.push(bulkCreateNfts(ids.map(nftId => mintNft(asset.id, nftId, holder, blockEventId))));
  await applyNftCountDelta(asset, holder, blockEventId, ids.length, promises);
};

/** Burns tokens out of `holder` — the mirror of `issueNfts`. The token rows stay, marked burned. */
const redeemNfts = async ({
  asset,
  holder,
  ids,
  blockEventId,
  promises,
}: NftSupplyChange): Promise<void> => {
  asset.totalSupply -= BigInt(ids.length);

  // one bulk update instead of N round trips
  const burnedNfts = await Promise.all(ids.map(nftId => burnNft(asset.id, nftId, blockEventId)));
  promises.push(bulkUpdateNfts(burnedNfts));
  clearTokenApprovals(asset.id, ids, holder, promises);
  await applyNftCountDelta(asset, holder, blockEventId, -ids.length, promises);
};

/** Moves tokens between holders: the token rows, their approvals, and both holding counts. */
const transferNfts = async ({
  asset,
  fromHolder,
  toHolder,
  ids,
  blockEventId,
  promises,
}: Omit<NftSupplyChange, 'holder'> & {
  fromHolder?: AssetHolderDetails;
  toHolder?: AssetHolderDetails;
}): Promise<void> => {
  const movedNfts = await Promise.all(
    ids.map(nftId => moveNft(asset.id, nftId, toHolder, blockEventId))
  );
  promises.push(bulkUpdateNfts(movedNfts));
  clearTokenApprovals(asset.id, ids, fromHolder, promises);
  if (fromHolder) {
    await applyNftCountDelta(asset, fromHolder, blockEventId, -ids.length, promises);
  }
  if (toHolder) {
    await applyNftCountDelta(asset, toHolder, blockEventId, ids.length, promises);
  }

  asset.totalTransfers += BigInt(1);
};

/**
 * From 8.1.3 the chain follows a controller transfer's holdings update with an event naming the
 * call, as it does for fungible assets; before that, `controller_transfer_to` is indistinguishable.
 */
const controllerTransferEventId = (block: SubstrateBlock, eventIdx: number): EventIdEnum => {
  const next = blockEvents(block)[eventIdx + 1]?.event;
  return next?.section === 'nft' && next.method === 'ControllerTransferTo'
    ? EventIdEnum.ControllerTransferTo
    : EventIdEnum.ControllerTransfer;
};

export const handleNftHoldingsUpdates = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, eventIdx, block, extrinsic, blockEventId } = extractArgs(event);
  const {
    callerDid: rawId,
    nfts: rawNftId,
    from: rawFromHolder,
    to: rawToHolder,
    updateReason: rawUpdateReason,
  } = decodeEvent(event);

  let fromHolder: AssetHolderDetails | undefined;

  if (!rawFromHolder.isEmpty) {
    fromHolder = await rawAssetHolderToAssetHolder(rawFromHolder, block, blockId, blockEventId);
  }
  let toHolder: AssetHolderDetails | undefined;

  if (!rawToHolder.isEmpty) {
    toHolder = await rawAssetHolderToAssetHolder(rawToHolder, block, blockId, blockEventId);
  }

  const promises = [];

  const did = getTextValue(rawId);
  const reason = getFirstKeyFromJson(rawUpdateReason);
  const value = getFirstValueFromJson(rawUpdateReason);

  const { assetId, ids } = await getNftId(rawNftId, block);

  const asset = await getAsset(assetId, event);
  asset.updatedEventId = blockEventId;

  let instructionId: string | undefined;
  let instructionMemo: string | undefined;
  let eventId: EventIdEnum;
  if (reason === 'issued') {
    eventId = EventIdEnum.IssuedNFT;
    await issueNfts({
      asset,
      holder: toHolder ?? portfolioHolder(did, 0),
      ids,
      blockEventId,
      promises,
    });
  } else if (reason === 'redeemed') {
    eventId = EventIdEnum.RedeemedNFT;
    await redeemNfts({
      asset,
      holder: fromHolder ?? portfolioHolder(did, 0),
      ids,
      blockEventId,
      promises,
    });
  } else if (reason === 'transferred' || reason === 'controllerTransfer') {
    await transferNfts({ asset, fromHolder, toHolder, ids, blockEventId, promises });

    if (reason === 'transferred') {
      eventId = EventIdEnum.Transfer;
      // FK to the padded `Instruction.id` — must carry the same zero-padding
      const details = transferDetails(value);
      instructionId = padNumericId(details.instructionId);
      instructionMemo = memoText(details.instructionMemo);
    } else {
      eventId = controllerTransferEventId(block, eventIdx);
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
        nftIds: ids.map(BigInt),
        instructionId,
        instructionMemo,
      },
      blockEventId,
      eventId,
      extrinsic
    ),
    asset.save()
  );

  await Promise.all(promises);
};

/**
 * The asset a pre-6.0 NFT collection belongs to.
 *
 * Before 6.0 an issuance named the collection, never the ticker, and nothing in the event maps one
 * to the other. The collection's own storage does, so it is read at the block that issued.
 */
export const assetOfCollection = async (
  rawCollectionId: Codec,
  block: SubstrateBlock
): Promise<string | undefined> => {
  const collection = (await api.query.nft.collection(getNumberValue(rawCollectionId))).toJSON() as {
    ticker?: string;
  } | null;

  return collection?.ticker ? getAssetId(collection.ticker, block) : undefined;
};

/**
 * The portfolio a pre-6.0 issuance or redemption used. Only the call names it — `issue_nft` and
 * `redeem_nft` both take it as their third argument — never the event. For a call made inside
 * another (a batch, a multisig) the default portfolio is assumed and the guess reported.
 */
const legacyPortfolioNumber = async (event: SubstrateEvent): Promise<number> => {
  const call = event.extrinsic?.extrinsic.method;

  if (call?.section === 'nft' && (call.method === 'issueNft' || call.method === 'redeemNft')) {
    const kind = call.args[2]?.toJSON() as { user?: number } | null;

    return kind && typeof kind === 'object' && kind.user !== undefined ? Number(kind.user) : 0;
  }

  const { block, eventIdx, moduleId, eventId } = extractArgs(event);

  await recordAnomaly({
    kind: AnomalyKind.UnreadableValue,
    detail: `${eventId} names no portfolio and was not a direct NFT call, so the default portfolio was assumed`,
    block,
    eventIdx,
    moduleId,
    eventId,
  });

  return 0;
};

/**
 * One pre-6.0 issuance or redemption, applied the way the holdings event applies them later.
 *
 * Before 6.0 minting and burning an NFT reported only `IssuedNFT` / `RedeemedNFT` — the holdings
 * event did not exist yet — so without this a pre-6.0 token was absent from every holding, supply
 * and count the index keeps for it.
 */
const applyLegacySupplyChange = async (
  event: SubstrateEvent,
  change: 'issue' | 'redeem',
  assetId: string,
  did: string,
  nftId: number
): Promise<void> => {
  const { blockId, block, blockEventId, eventIdx, extrinsic } = extractArgs(event);
  const holder = portfolioHolder(did, await legacyPortfolioNumber(event));
  const asset = await getAsset(assetId, event);
  asset.updatedEventId = blockEventId;

  const promises: Promise<void>[] = [];
  const supplyChange = { asset, holder, ids: [nftId], blockEventId, promises };

  if (change === 'issue') {
    await issueNfts(supplyChange);
  } else {
    await redeemNfts(supplyChange);
  }

  promises.push(
    createAssetTransaction(
      blockId,
      eventIdx,
      block.timestamp,
      {
        assetId,
        fromHolder: change === 'redeem' ? holder : undefined,
        toHolder: change === 'issue' ? holder : undefined,
        nftIds: [BigInt(nftId)],
      },
      blockEventId,
      change === 'issue' ? EventIdEnum.IssuedNFT : EventIdEnum.RedeemedNFT,
      extrinsic
    ),
    asset.save()
  );

  await Promise.all(promises);
};

/** Pre-6.0 `IssuedNFT(IdentityId, NFTCollectionId, NFTId)`. */
export const handleLegacyNftIssued = async (event: SubstrateEvent): Promise<void> => {
  const { block, eventIdx, moduleId, eventId } = extractArgs(event);
  const { did, collectionId, nftId } = decodeEvent(event);

  const assetId = await assetOfCollection(collectionId, block);

  if (!assetId) {
    await recordAnomaly({
      kind: AnomalyKind.MissingReferencedEntity,
      detail: `IssuedNFT named NFT collection ${getNumberValue(
        collectionId
      )}, which has no asset on chain`,
      block,
      eventIdx,
      moduleId,
      eventId,
    });

    return;
  }

  await applyLegacySupplyChange(event, 'issue', assetId, getTextValue(did), getNumberValue(nftId));
};

/** Pre-6.0 `RedeemedNFT(IdentityId, Ticker, NFTId)`. */
export const handleLegacyNftRedeemed = async (event: SubstrateEvent): Promise<void> => {
  const { block } = extractArgs(event);
  const { did, ticker, nftId } = decodeEvent(event);

  const assetId = await getAssetId(ticker, block);

  await applyLegacySupplyChange(event, 'redeem', assetId, getTextValue(did), getNumberValue(nftId));
};
