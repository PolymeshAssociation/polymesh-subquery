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
import { asCodec, flagOf, memberOf, optionOf } from '../../../utils/codec';
import { hexToString } from '../../../utils/common';
import { isPartialIndex } from '../../indexOrigin';
import { extractArgs } from '../common';
import { resolveIdentity } from '../identities/mapIdentities';

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

  const assets = api.query.asset?.assets;
  const details = assets ? optionOf(await assets(assetId), 'asset.assets') : undefined;

  if (!details) {
    await report(`asset ${assetId} is neither indexed nor readable from chain storage`);

    return undefined;
  }

  const ownerId = await resolveIdentity(getTextValue(memberOf(details, 'ownerDid')), {
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

  const rawTickerValue = optionOf(rawTicker, 'asset.assetIdTicker');
  const ticker = rawTickerValue ? hexToString(rawTickerValue.toString()) : undefined;
  const assetType = memberOf(details, 'assetType');
  const isNftCollection = flagOf(assetType, 'isNonFungible');

  const asset = Asset.create({
    id: assetId,
    assetId,
    ticker,
    name: bytesToString(asCodec(rawName)) || undefined,
    type: await getAssetType(assetType, block, eventIdx),
    isNftCollection,
    fundingRound: bytesToString(asCodec(rawFundingRound)) || undefined,
    isDivisible: getBooleanValue(memberOf(details, 'divisible')),
    isFrozen: getBooleanValue(asCodec(rawFrozen)),
    holderCount: 0,
    identifiers: getSecurityIdentifiers(asCodec(rawIdentifiers)),
    ownerId,
    totalSupply: getBigIntValue(memberOf(details, 'totalSupply')),
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
