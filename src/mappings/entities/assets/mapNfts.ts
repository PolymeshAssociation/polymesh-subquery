import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { Asset, EventIdEnum, HolderKind, Nft, NftHolder } from '../../../types';
import {
  AssetHolderDetails,
  bytesToString,
  getAssetId,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  getNftId,
  getPortfolioId,
  getTextValue,
  padId,
  padNumericId,
  portfolioHolder,
  rawAssetHolderToAssetHolder,
} from '../../../utils';
import { extractArgs, getAsset } from './../common';
import { createAssetTransaction, getHolding } from './mapAsset';

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
    metadata: [],
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
 * holder in one block — turned that into Σ(1..n) array serialisations and poisoned the store
 * cache with 30k-element arrays. So holder mutations are buffered per block and each holder is
 * saved once, when the block changes (or `flushNftBuffer` is called from the block handler).
 * Nothing inside the indexer reads `NftHolder` — it is written for external queries only — so a
 * holder being at most one block-handler interval stale is acceptable.
 */
let bufferedBlock: string | undefined;
const bufferedHolders = new Map<string, NftHolder>();

export const flushNftBuffer = async (): Promise<void> => {
  if (bufferedHolders.size === 0) {
    return;
  }

  await Promise.all([...bufferedHolders.values()].map(holder => holder.save()));
  bufferedHolders.clear();
  bufferedBlock = undefined;
};

/** Test hook. */
export const __resetNftBuffer = (): void => {
  bufferedHolders.clear();
  bufferedBlock = undefined;
};

const bufferHolder = async (blockId: string, holder: NftHolder): Promise<void> => {
  if (blockId !== bufferedBlock) {
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
  const { params, block, blockEventId } = extractArgs(event);
  const [, rawAssetId] = params;
  const assetId = await getAssetId(rawAssetId, block);
  const asset = await getAsset(assetId);

  asset.isNftCollection = true;
  asset.updatedEventId = blockEventId;
  return asset.save();
};

export const handleNftHoldingsUpdates = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, eventIdx, block, extrinsic, blockEventId } = extractArgs(event);
  const [rawId, rawNftId, rawFromHolder, rawToHolder, rawUpdateReason] = params;

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

  const asset = await getAsset(assetId);
  asset.updatedEventId = blockEventId;

  let instructionId: string;
  let instructionMemo: string;
  let eventId: EventIdEnum;
  if (reason === 'issued') {
    eventId = EventIdEnum.IssuedNFT;
    asset.totalSupply += BigInt(ids.length);

    // the whole-array rollup, kept for the SDK and still buffered per block
    const nftHolder = await getNftHolder(assetId, did, blockId, blockEventId);
    const heldBefore = nftHolder.nftIds.length;
    nftHolder.nftIds.push(...bigIds);
    countHolderChange(asset, heldBefore, nftHolder.nftIds.length);
    nftHolder.updatedEventId = blockEventId;
    await bufferHolder(blockId, nftHolder);

    // per-token rows — one bulk insert instead of N round trips
    const holder = toHolder ?? portfolioHolder(did, 0);
    const mintedNfts = ids.map(nftId => mintNft(assetId, nftId, holder, blockEventId));
    promises.push(bulkCreateNfts(mintedNfts));
    await adjustNftCount(assetId, holder, blockEventId, ids.length, promises);
  } else if (reason === 'redeemed') {
    eventId = EventIdEnum.RedeemedNFT;
    asset.totalSupply -= BigInt(ids.length);

    const nftHolder = await getNftHolder(assetId, did, blockId, blockEventId);
    const heldBefore = nftHolder.nftIds.length;
    nftHolder.nftIds = nftHolder.nftIds.filter(heldId => !bigIds.includes(heldId));
    countHolderChange(asset, heldBefore, nftHolder.nftIds.length);
    nftHolder.updatedEventId = blockEventId;
    await bufferHolder(blockId, nftHolder);

    // one bulk update instead of N round trips (and no n-element array filter per token)
    const holder = fromHolder ?? portfolioHolder(did, 0);
    const burnedNfts = await Promise.all(ids.map(nftId => burnNft(assetId, nftId, blockEventId)));
    promises.push(bulkUpdateNfts(burnedNfts));
    await adjustNftCount(assetId, holder, blockEventId, -ids.length, promises);
  } else if (reason === 'transferred' || reason === 'controllerTransfer') {
    // Same-identity moves share one rollup row. Resolving `toRollup` independently would, for the
    // first same-block touch of that holder, create a second in-memory copy of the same
    // unbuffered row (`NftHolder.get` → `Object.assign` still shares the `nftIds` array
    // reference) — the two mutations below would then race on `bufferHolder`, and whichever
    // `bufferHolder` call landed second would silently drop the other's edit.
    const fromRollup = await getNftHolder(assetId, fromDid, blockId, blockEventId);
    const toRollup =
      toDid === fromDid ? fromRollup : await getNftHolder(assetId, toDid, blockId, blockEventId);
    const fromBefore = fromRollup.nftIds.length;
    const toBefore = toRollup.nftIds.length;
    fromRollup.nftIds = fromRollup.nftIds.filter(id => !bigIds.includes(id));
    toRollup.nftIds.push(...bigIds);
    if (toRollup !== fromRollup) {
      countHolderChange(asset, fromBefore, fromRollup.nftIds.length);
      countHolderChange(asset, toBefore, toRollup.nftIds.length);
    }
    fromRollup.updatedEventId = blockEventId;
    toRollup.updatedEventId = blockEventId;

    await bufferHolder(blockId, fromRollup);
    await bufferHolder(blockId, toRollup);

    const movedNfts = await Promise.all(
      ids.map(nftId => moveNft(assetId, nftId, toHolder, blockEventId))
    );
    promises.push(bulkUpdateNfts(movedNfts));
    await adjustNftCount(assetId, fromHolder, blockEventId, -ids.length, promises);
    await adjustNftCount(assetId, toHolder, blockEventId, ids.length, promises);

    asset.totalTransfers += BigInt(1);

    if (reason === 'transferred') {
      eventId = EventIdEnum.Transfer;
      const details = value as unknown as {
        readonly instructionId: Codec;
        readonly instructionMemo: Codec;
      };

      // FK to the padded `Instruction.id` (D12) — must carry the same zero-padding
      instructionId = padNumericId(getTextValue(details.instructionId));
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
