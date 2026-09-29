import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { AnomalyKind, Asset } from '../../../types';
import {
  bytesToString,
  getAssetType,
  getBigIntValue,
  getBooleanValue,
  getSecurityIdentifiers,
  getTextValue,
} from '../../../utils';
import { recordAnomaly } from '../../../utils/anomaly';
import { hexToString } from '../../../utils/common';
import { isPartialIndex } from '../../indexOrigin';
import { extractArgs } from '../common';
import { resolveIdentity } from '../identities/mapIdentities';

interface ChainAssetDetails {
  totalSupply: Codec;
  ownerDid: Codec;
  divisible: Codec;
  assetType: Codec;
}

/**
 * An asset the index has never seen, built from chain storage at the current block.
 *
 * A handler meets one when the index started after the asset was created, or when a gap left its
 * creation unwritten. The chain holds nearly everything creation would have recorded — supply,
 * owner, divisibility, type, name, identifiers, freeze and compliance state — so the row is built
 * from that rather than zero-filled, and the supply it carries is the real one, which every later
 * issue and redemption then adjusts correctly. What the chain does not hold is what the index
 * derives itself: the holder and transfer counts start from zero here, which `IndexOrigin` states.
 *
 * Readable from v7, where assets are keyed by `AssetId`; earlier, and for an asset the chain does
 * not know either, it is recorded as missing and `undefined` is returned. On a genesis replay any
 * use of this path is a gap in the index and is recorded as one; on a partial index it is expected.
 */
export const assetFromChain = async (
  assetId: string,
  event: SubstrateEvent
): Promise<Asset | undefined> => {
  const { block, blockEventId, eventIdx, moduleId, eventId } = extractArgs(event);
  const report = (detail: string) =>
    recordAnomaly({
      kind: AnomalyKind.MissingReferencedEntity,
      detail,
      block,
      eventIdx,
      moduleId,
      eventId,
    });

  const assets = api.query.asset.assets as unknown as
    | ((id: string) => Promise<{ isNone: boolean; unwrap(): ChainAssetDetails }>)
    | undefined;
  const stored = assets ? await assets(assetId) : undefined;

  if (!stored || stored.isNone) {
    await report(`asset ${assetId} is neither indexed nor readable from chain storage`);

    return undefined;
  }

  const details = stored.unwrap();
  const ownerId = await resolveIdentity(getTextValue(details.ownerDid), {
    reason: 'an asset built from chain storage',
    eventIdx,
    block,
    blockEventId,
  });

  if (!ownerId) {
    return undefined;
  }

  const [rawName, rawFundingRound, rawIdentifiers, rawFrozen, rawTicker, rawCompliance] =
    await Promise.all([
      api.query.asset.assetNames(assetId),
      api.query.asset.fundingRound(assetId),
      api.query.asset.assetIdentifiers(assetId),
      api.query.asset.frozen(assetId),
      api.query.asset.assetIdTicker(assetId),
      api.query.complianceManager.assetCompliances(assetId),
    ]);

  const ticker = (rawTicker as unknown as { isSome: boolean; unwrap(): Codec }).isSome
    ? hexToString((rawTicker as unknown as { unwrap(): Codec }).unwrap().toString())
    : undefined;
  const isNftCollection = (details.assetType as unknown as { isNonFungible: boolean })
    .isNonFungible;

  const asset = Asset.create({
    id: assetId,
    assetId,
    ticker,
    name: bytesToString(rawName as unknown as Codec) || undefined,
    type: await getAssetType(details.assetType, block, eventIdx),
    isNftCollection,
    fundingRound: bytesToString(rawFundingRound as unknown as Codec) || undefined,
    isDivisible: getBooleanValue(details.divisible),
    isFrozen: getBooleanValue(rawFrozen as unknown as Codec),
    holderCount: 0,
    identifiers: getSecurityIdentifiers(rawIdentifiers as unknown as Codec),
    ownerId,
    totalSupply: getBigIntValue(details.totalSupply),
    totalTransfers: BigInt(0),
    isCompliancePaused: Boolean((rawCompliance.toJSON() as { paused?: boolean } | null)?.paused),
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  });

  await asset.save();

  if (!(await isPartialIndex())) {
    await report(`asset ${assetId} was not indexed, so it was built from chain storage`);
  }

  return asset;
};
