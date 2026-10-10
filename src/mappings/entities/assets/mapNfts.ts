import { Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import {
  AnomalyKind,
  Asset,
  EventIdEnum,
  HolderKind,
  Nft,
  NftApproval,
  NftHolder,
} from '../../../types';
import {
  AssetHolderDetails,
  getAssetId,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  getNftId,
  getNumberValue,
  getPortfolioId,
  getTextValue,
  padId,
  padNumericId,
  portfolioHolder,
  rawAssetHolderToAssetHolder,
} from '../../../utils';
import { recordAnomaly } from '../../../utils/anomaly';
import { extractArgs, getAsset } from './../common';
import { createAssetTransaction, getHolding } from './mapAsset';
import { nftApprovalId } from './mapNftApprovals';
import { memoText } from '../../../utils/text';

const nftRowId = (assetId: string, nftId: number): string => `${assetId}/${padId(String(nftId))}`;

const locationOf = (
  holder: AssetHolderDetails | undefined
): Pick<Nft, 'portfolioId' | 'accountId' | 'identityId'> => ({
  portfolioId: holder?.holderKind === HolderKind.Portfolio ? getPortfolioId(holder) : undefined,
  accountId: holder?.holderKind === HolderKind.Account ? holder.account : undefined,
  identityId: holder?.identityId || undefined,
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
    ...locationOf(holder),
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
  holder: AssetHolderDetails,
  blockEventId: string
): Promise<Nft | undefined> => {
  const nft = await Nft.get(nftRowId(assetId, nftId));
  if (!nft) {
    return undefined;
  }
  Object.assign(nft, locationOf(holder));
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
 * `Asset.holderCount` counts identities, and for a collection an identity holds it while its
 * `NftHolder` rollup is non-empty — the NFT counterpart of `applyHoldingDelta`'s zero crossing on
 * `AssetHolder`. Without it every collection reported 0 holders.
 */
const countHolderChange = (asset: Asset, before: number, after: number): void => {
  if (before === 0 && after > 0) {
    asset.holderCount += 1;
  } else if (before > 0 && after === 0) {
    asset.holderCount = Math.max(0, asset.holderCount - 1);
  }
};

/**
 * `NftHolder.nftIds` is a JSON array, and under historical mode every `.save()` writes a new
 * versioned row carrying the whole array. A bulk mint — hundreds of `NFTPortfolioUpdated` for one
 * holder in one block — turned that into Σ(1..n) array serialisations and poisoned the store cache
 * with 30k-element arrays. So holder mutations are buffered across the block's events and each
 * holder is saved once, by the block's last holdings event.
 *
 * The flush stays inside the block that made the change. A row's validity begins at the block it is
 * saved in, so flushing from a later block would date the change to that later block instead — and
 * relying on a block handler to do it means subscribing to every block, which costs the dictionary's
 * ability to skip the ~98% of heights that carry nothing. The block-change flush below is kept as a
 * backstop for the case where the event stream cannot be read.
 *
 * **Why this is module state, and stays so.** It is the one piece of mutable state in the mappings
 * that lives outside the block context, deliberately. The block context holds only what can be
 * lost and redone without changing what is written; a write buffer is the opposite. Dropping the
 * buffer altogether brings back a full rewrite of the holder's array on every event. What makes it
 * safe is how narrow its lifetime is: filled and flushed within one block, by the same worker that
 * indexes the whole block, and lost only when that block is itself replayed — a handler that throws
 * fails the block, and the worker restarts with nothing buffered. The backstop is the one path
 * that breaks the rule, and it reports itself: a late flush is recorded rather than taken quietly.
 */
let bufferedBlock: string | undefined;
const bufferedHolders = new Map<string, NftHolder>();

/**
 * The tokens that have left a buffered holder this block, taken out of its `nftIds` in one pass when
 * the buffer is flushed. Tokens that arrive are appended straight away.
 *
 * So a block costs a holder at most one pass over its tokens, and only if some left. Filtering on
 * every event cost a pass per event: testnet blocks 15,391,560 onward redeemed 400 tokens a block,
 * one per event, from one portfolio holding tens of thousands. Holding the tokens as a set instead
 * cost two passes per holder per block even for a holder only receiving, which made the NFT
 * settlements of testnet blocks 13,527,617 onward 2.5 times slower.
 *
 * A token leaving is one its holder holds (the chain checks), so the holder holds its `nftIds` less
 * the tokens that have left.
 */
const leftIds = new WeakMap<NftHolder, Set<bigint>>();

const heldCount = (holder: NftHolder): number =>
  holder.nftIds.length - (leftIds.get(holder)?.size ?? 0);

const addTokens = (holder: NftHolder, ids: bigint[]): void => {
  const left = leftIds.get(holder);

  ids.forEach(nftId => {
    // a token that left earlier in the block and came back is still in `nftIds`
    if (!left?.delete(nftId)) {
      holder.nftIds.push(nftId);
    }
  });
};

const removeTokens = (holder: NftHolder, ids: bigint[]): void => {
  let left = leftIds.get(holder);

  if (!left) {
    left = new Set();
    leftIds.set(holder, left);
  }

  ids.forEach(nftId => left.add(nftId));
};

export const flushNftBuffer = async (): Promise<void> => {
  if (bufferedHolders.size === 0) {
    return;
  }

  bufferedHolders.forEach(holder => {
    const left = leftIds.get(holder);
    if (left?.size) {
      holder.nftIds = holder.nftIds.filter(nftId => !left.has(nftId));
    }
    leftIds.delete(holder);
  });
  await Promise.all([...bufferedHolders.values()].map(holder => holder.save()));
  bufferedHolders.clear();
  bufferedBlock = undefined;
};

const HOLDINGS_EVENTS = new Set([
  'NFTPortfolioUpdated',
  'NFTHoldingsUpdated',
  'IssuedNFT',
  'RedeemedNFT',
]);

/**
 * Whether this is the last event in its block that can add to the buffer, and so the one that has
 * to write it out. Read from the block's own event list, which is what the runtime already handed
 * the worker — no extra chain read.
 */
const lastHoldingsEvent = (event: SubstrateEvent): boolean => {
  const records = (event.block.events ?? []) as unknown as {
    event: { section: string; method: string };
  }[];

  for (let i = event.idx + 1; i < records.length; i += 1) {
    const emitted = records[i]?.event;

    if (emitted?.section === 'nft' && HOLDINGS_EVENTS.has(emitted.method)) {
      return false;
    }
  }

  return true;
};

/** Test hook. */
export const __resetNftBuffer = (): void => {
  bufferedHolders.clear();
  bufferedBlock = undefined;
};

const bufferHolder = async (
  blockId: string,
  holder: NftHolder,
  event: SubstrateEvent
): Promise<void> => {
  if (blockId !== bufferedBlock) {
    if (bufferedHolders.size > 0) {
      await recordAnomaly({
        kind: AnomalyKind.DeferredWrite,
        detail: `${bufferedHolders.size} NftHolder write(s) from block ${bufferedBlock} were flushed from block ${blockId}, so they are dated one block late`,
        block: event.block,
        eventIdx: event.idx,
      });
    }

    await flushNftBuffer();
    bufferedBlock = blockId;
  }

  bufferedHolders.set(holder.id, holder);
};

export const getNftHolder = async (
  assetId: string,
  did: string,
  blockId: string,
  blockEventId: string
): Promise<NftHolder> => {
  const id = `${assetId}/${did}`;

  // A holder mutated earlier in this same block lives in the buffer, not yet in the store.
  const buffered = bufferedBlock === blockId ? bufferedHolders.get(id) : undefined;
  if (buffered) {
    return buffered;
  }

  const nftHolder = await NftHolder.get(id);

  if (nftHolder) {
    return nftHolder;
  }

  // Not saved here — every caller mutates `nftIds` next and hands this to `bufferHolder`, whose
  // eventual flush is the row's only write. Saving here too would cost a second row version for
  // every newly-first-seen holder.
  return NftHolder.create({
    id,
    identityId: did,
    assetId,
    nftIds: [],
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  });
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
  did: string;
  holder: AssetHolderDetails;
  ids: number[];
  blockId: string;
  blockEventId: string;
  event: SubstrateEvent;
  promises: Promise<void>[];
}

/** Mints tokens into `holder`: supply, the identity rollup, one row per token, and the holding count. */
const issueNfts = async ({
  asset,
  did,
  holder,
  ids,
  blockId,
  blockEventId,
  event,
  promises,
}: NftSupplyChange): Promise<void> => {
  asset.totalSupply += BigInt(ids.length);

  // the whole-array rollup, kept for the SDK and still buffered per block
  const nftHolder = await getNftHolder(asset.id, did, blockId, blockEventId);
  const heldBefore = heldCount(nftHolder);
  addTokens(nftHolder, ids.map(BigInt));
  countHolderChange(asset, heldBefore, heldCount(nftHolder));
  nftHolder.updatedEventId = blockEventId;
  await bufferHolder(blockId, nftHolder, event);

  // per-token rows — one bulk insert instead of N round trips
  promises.push(bulkCreateNfts(ids.map(nftId => mintNft(asset.id, nftId, holder, blockEventId))));
  await adjustNftCount(asset.id, holder, blockEventId, ids.length, promises);
};

/** Burns tokens out of `holder` — the mirror of `issueNfts`. The token rows stay, marked burned. */
const redeemNfts = async ({
  asset,
  did,
  holder,
  ids,
  blockId,
  blockEventId,
  event,
  promises,
}: NftSupplyChange): Promise<void> => {
  asset.totalSupply -= BigInt(ids.length);

  const bigIds = ids.map(BigInt);
  const nftHolder = await getNftHolder(asset.id, did, blockId, blockEventId);
  const heldBefore = heldCount(nftHolder);
  removeTokens(nftHolder, bigIds);
  countHolderChange(asset, heldBefore, heldCount(nftHolder));
  nftHolder.updatedEventId = blockEventId;
  await bufferHolder(blockId, nftHolder, event);

  // one bulk update instead of N round trips (and no n-element array filter per token)
  const burnedNfts = await Promise.all(ids.map(nftId => burnNft(asset.id, nftId, blockEventId)));
  promises.push(bulkUpdateNfts(burnedNfts));
  clearTokenApprovals(asset.id, ids, holder, promises);
  await adjustNftCount(asset.id, holder, blockEventId, -ids.length, promises);
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
  let fromDid: string;
  let toDid: string;

  if (!rawFromHolder.isEmpty) {
    fromHolder = await rawAssetHolderToAssetHolder(rawFromHolder, block, blockId, blockEventId);
    fromDid = fromHolder.identityId;
  }
  let toHolder: AssetHolderDetails | undefined;

  if (!rawToHolder.isEmpty) {
    toHolder = await rawAssetHolderToAssetHolder(rawToHolder, block, blockId, blockEventId);
    toDid = toHolder.identityId;
  }

  const promises = [];

  const did = getTextValue(rawId);
  const reason = getFirstKeyFromJson(rawUpdateReason);
  const value = getFirstValueFromJson(rawUpdateReason);

  const { assetId, ids } = await getNftId(rawNftId, block);
  // NftHolder.nftIds is [BigInt] (G10); getNftId still yields JS numbers
  const bigIds = ids.map(BigInt);

  const asset = await getAsset(assetId, event);
  asset.updatedEventId = blockEventId;

  let instructionId: string;
  let instructionMemo: string | undefined;
  let eventId: EventIdEnum;
  if (reason === 'issued') {
    eventId = EventIdEnum.IssuedNFT;
    await issueNfts({
      asset,
      did,
      holder: toHolder ?? portfolioHolder(did, 0),
      ids,
      blockId,
      blockEventId,
      event,
      promises,
    });
  } else if (reason === 'redeemed') {
    eventId = EventIdEnum.RedeemedNFT;
    await redeemNfts({
      asset,
      did,
      holder: fromHolder ?? portfolioHolder(did, 0),
      ids,
      blockId,
      blockEventId,
      event,
      promises,
    });
  } else if (reason === 'transferred' || reason === 'controllerTransfer') {
    // Same-identity moves share one rollup row. Resolving `toRollup` independently would, for the
    // first same-block touch of that holder, create a second in-memory copy of the same
    // unbuffered row (`NftHolder.get` → `Object.assign` still shares the `nftIds` array
    // reference) — the two mutations below would then race on `bufferHolder`, and whichever
    // `bufferHolder` call landed second would silently drop the other's edit.
    const fromRollup = await getNftHolder(assetId, fromDid, blockId, blockEventId);
    const toRollup =
      toDid === fromDid ? fromRollup : await getNftHolder(assetId, toDid, blockId, blockEventId);
    const fromBefore = heldCount(fromRollup);
    const toBefore = heldCount(toRollup);
    removeTokens(fromRollup, bigIds);
    addTokens(toRollup, bigIds);
    if (toRollup !== fromRollup) {
      countHolderChange(asset, fromBefore, heldCount(fromRollup));
      countHolderChange(asset, toBefore, heldCount(toRollup));
    }
    fromRollup.updatedEventId = blockEventId;
    toRollup.updatedEventId = blockEventId;

    await bufferHolder(blockId, fromRollup, event);
    await bufferHolder(blockId, toRollup, event);

    const movedNfts = await Promise.all(
      ids.map(nftId => moveNft(assetId, nftId, toHolder, blockEventId))
    );
    promises.push(bulkUpdateNfts(movedNfts));
    clearTokenApprovals(assetId, ids, fromHolder, promises);
    await adjustNftCount(assetId, fromHolder, blockEventId, -ids.length, promises);
    await adjustNftCount(assetId, toHolder, blockEventId, ids.length, promises);

    asset.totalTransfers += BigInt(1);

    if (reason === 'transferred') {
      eventId = EventIdEnum.Transfer;
      const details = value as unknown as {
        readonly instructionId: Codec;
        readonly instructionMemo: Codec;
      };

      // FK to the padded `Instruction.id` — must carry the same zero-padding
      instructionId = padNumericId(getTextValue(details.instructionId));
      instructionMemo = memoText(details.instructionMemo);
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

  if (lastHoldingsEvent(event)) {
    await flushNftBuffer();
  }
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
  const supplyChange = { asset, did, holder, ids: [nftId], blockId, blockEventId, event, promises };

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

  if (lastHoldingsEvent(event)) {
    await flushNftBuffer();
  }
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
