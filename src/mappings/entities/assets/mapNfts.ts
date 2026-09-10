import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { EventIdEnum, NftHolder } from '../../../types';
import {
  AssetHolderDetails,
  bytesToString,
  getAssetId,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  getNftId,
  getTextValue,
  rawAssetHolderToAssetHolder,
} from '../../../utils';
import { extractArgs, getAsset } from './../common';
import { createAssetTransaction } from './mapAsset';

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

  const asset = await getAsset(assetId);
  asset.updatedBlockId = blockId;

  let instructionId: string;
  let instructionMemo: string;
  let eventId: EventIdEnum;
  if (reason === 'issued') {
    eventId = EventIdEnum.IssuedNFT;
    asset.totalSupply += BigInt(ids.length);

    const nftHolder = await getNftHolder(assetId, did, blockId);
    nftHolder.nftIds.push(...ids);
    nftHolder.updatedBlockId = blockId;
    await bufferHolder(blockId, nftHolder);
  } else if (reason === 'redeemed') {
    eventId = EventIdEnum.RedeemedNFT;
    asset.totalSupply -= BigInt(ids.length);

    const nftHolder = await getNftHolder(assetId, did, blockId);
    nftHolder.nftIds = nftHolder.nftIds.filter(heldId => !ids.includes(heldId));
    nftHolder.updatedBlockId = blockId;
    await bufferHolder(blockId, nftHolder);
  } else if (reason === 'transferred' || reason === 'controllerTransfer') {
    const [fromHolder, toHolder] = await Promise.all([
      getNftHolder(assetId, fromDid, blockId),
      getNftHolder(assetId, toDid, blockId),
    ]);
    fromHolder.nftIds = fromHolder.nftIds.filter(id => !ids.includes(id));
    toHolder.nftIds.push(...ids);
    fromHolder.updatedBlockId = blockId;
    toHolder.updatedBlockId = blockId;

    await bufferHolder(blockId, fromHolder);
    await bufferHolder(blockId, toHolder);

    asset.totalTransfers += BigInt(1);

    if (reason === 'transferred') {
      eventId = EventIdEnum.Transfer;
      const details = value as unknown as {
        readonly instructionId: Codec;
        readonly instructionMemo: Codec;
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
