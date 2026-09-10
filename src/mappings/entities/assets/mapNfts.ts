import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { EventIdEnum, HolderKind, Nft, NftHolder } from '../../../types';
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

const mintNft = (
  assetId: string,
  nftId: number,
  holder: AssetHolderDetails,
  blockId: string
): Promise<void> =>
  Nft.create({
    id: nftRowId(assetId, nftId),
    assetId,
    nftId: BigInt(nftId),
    ...locationOf(holder),
    metadata: [],
    mintedBlockId: blockId,
    updatedBlockId: blockId,
  }).save();

/** Moves a token to a new location. A miss means the row predates the seed — reconciliation covers it. */
const moveNft = async (
  assetId: string,
  nftId: number,
  holder: AssetHolderDetails,
  blockId: string
): Promise<void> => {
  const nft = await Nft.get(nftRowId(assetId, nftId));
  if (!nft) {
    return;
  }
  Object.assign(nft, locationOf(holder));
  nft.updatedBlockId = blockId;
  return nft.save();
};

/** Marks a token burned. The row stays queryable; `burnedBlockId: { isNull: true }` filters it out. */
const burnNft = async (assetId: string, nftId: number, blockId: string): Promise<void> => {
  const nft = await Nft.get(nftRowId(assetId, nftId));
  if (!nft) {
    return;
  }
  nft.burnedBlockId = blockId;
  nft.updatedBlockId = blockId;
  return nft.save();
};

const adjustNftCount = async (
  assetId: string,
  holder: AssetHolderDetails | undefined,
  blockId: string,
  delta: number,
  promises: Promise<void>[]
): Promise<void> => {
  if (!holder) {
    return;
  }
  const holding = await getHolding(assetId, holder, blockId);
  holding.nftCount += delta;
  holding.updatedBlockId = blockId;
  promises.push(holding.save());
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
  blockId: string
): Promise<NftHolder> => {
  const id = `${assetId}/${did}`;

  // A holder mutated earlier in this same block lives in the buffer, not yet in the store.
  const buffered = bufferedBlock === blockId ? bufferedHolders.get(id) : undefined;
  if (buffered) {
    return buffered;
  }

  let nftHolder = await NftHolder.get(id);

  if (!nftHolder) {
    nftHolder = NftHolder.create({
      id,
      identityId: did,
      assetId,
      nftIds: [],
      createdBlockId: blockId,
      updatedBlockId: blockId,
    });
    await nftHolder.save();
  }

  return nftHolder;
};

export const handleNftCollectionCreated = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, block } = extractArgs(event);
  const [, rawAssetId] = params;
  const assetId = await getAssetId(rawAssetId, block);
  const asset = await getAsset(assetId);

  asset.isNftCollection = true;
  asset.updatedBlockId = blockId;
  return asset.save();
};

export const handleNftHoldingsUpdates = async (event: SubstrateEvent): Promise<void> => {
  const { params, blockId, eventIdx, block, extrinsic, blockEventId } = extractArgs(event);
  const [rawId, rawNftId, rawFromHolder, rawToHolder, rawUpdateReason] = params;

  let fromHolder: AssetHolderDetails | undefined;
  let fromDid: string;
  let toDid: string;

  if (!rawFromHolder.isEmpty) {
    fromHolder = await rawAssetHolderToAssetHolder(rawFromHolder, block, blockId);
    fromDid = fromHolder.identityId;
  }
  let toHolder: AssetHolderDetails | undefined;

  if (!rawToHolder.isEmpty) {
    toHolder = await rawAssetHolderToAssetHolder(rawToHolder, block, blockId);
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
  asset.updatedBlockId = blockId;

  let instructionId: string;
  let instructionMemo: string;
  let eventId: EventIdEnum;
  if (reason === 'issued') {
    eventId = EventIdEnum.IssuedNFT;
    asset.totalSupply += BigInt(ids.length);

    // the whole-array rollup, kept for the SDK and still buffered per block
    const nftHolder = await getNftHolder(assetId, did, blockId);
    nftHolder.nftIds.push(...bigIds);
    nftHolder.updatedBlockId = blockId;
    await bufferHolder(blockId, nftHolder);

    // per-token rows — N small inserts instead of one lengthening array rewrite
    const holder = toHolder ?? portfolioHolder(did, 0);
    ids.forEach(nftId => promises.push(mintNft(assetId, nftId, holder, blockId)));
    await adjustNftCount(assetId, holder, blockId, ids.length, promises);
  } else if (reason === 'redeemed') {
    eventId = EventIdEnum.RedeemedNFT;
    asset.totalSupply -= BigInt(ids.length);

    const nftHolder = await getNftHolder(assetId, did, blockId);
    nftHolder.nftIds = nftHolder.nftIds.filter(heldId => !bigIds.includes(heldId));
    nftHolder.updatedBlockId = blockId;
    await bufferHolder(blockId, nftHolder);

    // one single-column update per token instead of an n-element array filter
    const holder = fromHolder ?? portfolioHolder(did, 0);
    ids.forEach(nftId => promises.push(burnNft(assetId, nftId, blockId)));
    await adjustNftCount(assetId, holder, blockId, -ids.length, promises);
  } else if (reason === 'transferred' || reason === 'controllerTransfer') {
    const [fromRollup, toRollup] = await Promise.all([
      getNftHolder(assetId, fromDid, blockId),
      getNftHolder(assetId, toDid, blockId),
    ]);
    fromRollup.nftIds = fromRollup.nftIds.filter(id => !bigIds.includes(id));
    toRollup.nftIds.push(...bigIds);
    fromRollup.updatedBlockId = blockId;
    toRollup.updatedBlockId = blockId;

    await bufferHolder(blockId, fromRollup);
    await bufferHolder(blockId, toRollup);

    ids.forEach(nftId => promises.push(moveNft(assetId, nftId, toHolder, blockId)));
    await adjustNftCount(assetId, fromHolder, blockId, -ids.length, promises);
    await adjustNftCount(assetId, toHolder, blockId, ids.length, promises);

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
