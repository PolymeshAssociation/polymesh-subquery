import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { Nft, NftApproval, NftOperatorApproval } from '../../../types';
import {
  blockTime,
  getAssetId,
  getBooleanValue,
  getNumberValue,
  getTextValue,
  ledgerAccount,
  padId,
} from '../../../utils';
import { extractArgs, getOrAnomaly } from '../common';

/**
 * NFT approvals, as the chain keeps them: a *set* of standing permissions rather than a log.
 *
 * Two kinds, with different lifetimes:
 *
 * - **Per-token** — at most one spender per token, each approval replacing the last, consumed when
 *   the spender uses it, and cleared with no event of its own whenever the token leaves the account
 *   holding it. That last route is handled where tokens move, in the NFT holdings handler; a model
 *   that listened only to the three approval events would keep showing a spender who can no longer
 *   move the token.
 * - **Operator** — collection-wide, many at once, never consumed, and surviving transfers, so only
 *   its own event ever changes it.
 *
 * The owner named on every approval event is the account *holding* the token, not the caller: an
 * operator can set or spend an approval on the holder's behalf.
 */

/** The id a token's approval shares with its `Nft` row, so the two join on id alone. */
export const nftApprovalId = (assetId: string, nftId: number): string =>
  `${assetId}/${padId(String(nftId))}`;

/**
 * `NFTApproval` — a holder approved one spender for one token, replacing any earlier approval, or
 * named no spender and so revoked it.
 */
export const handleNftApproval = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockId, blockEventId } = extractArgs(event);
  const { owner: rawOwner, spender: rawSpender, assetId: rawAssetId, nftId } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const id = nftApprovalId(assetId, getNumberValue(nftId));

  if (rawSpender.isEmpty) {
    await NftApproval.remove(id);

    return;
  }

  const owner = getTextValue(rawOwner);
  const spender = getTextValue(rawSpender);

  // Both are relations, and either can be an account nothing else has indexed yet — a spender in
  // particular need never have signed anything of its own.
  await Promise.all([
    ledgerAccount(owner, blockId, blockTime(block), blockEventId),
    ledgerAccount(spender, blockId, blockTime(block), blockEventId),
  ]);

  const [existing, nft] = await Promise.all([
    NftApproval.get(id),
    getOrAnomaly(nftRowId => Nft.get(nftRowId), id, 'Nft', event),
  ]);

  await NftApproval.create({
    id,
    nftId: nft?.id,
    assetId,
    ownerId: owner,
    spenderId: spender,
    // a replaced approval is the same standing row with a new spender, so it keeps its origin
    createdEventId: existing?.createdEventId ?? blockEventId,
    updatedEventId: blockEventId,
  }).save();
};

/**
 * `NFTApprovalSpent` — the approved spender moved the token, which consumes the approval. The
 * transfer that follows would clear it anyway; the chain consumes it here so that spending is
 * correct on its own, and so does this.
 */
export const handleNftApprovalSpent = async (event: SubstrateEvent): Promise<void> => {
  const { block } = extractArgs(event);
  const { assetId: rawAssetId, nftId } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);

  await NftApproval.remove(nftApprovalId(assetId, getNumberValue(nftId)));
};

/**
 * `NFTApprovalForAll` — a holder granted or withdrew an operator's standing approval over everything
 * it holds in one collection. A grant that already stands keeps its original row.
 */
export const handleNftApprovalForAll = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockId, blockEventId } = extractArgs(event);
  const {
    owner: rawOwner,
    operator: rawOperator,
    assetId: rawAssetId,
    approved,
  } = decodeEvent(event);

  const assetId = await getAssetId(rawAssetId, block);
  const owner = getTextValue(rawOwner);
  const operator = getTextValue(rawOperator);
  const id = `${assetId}/${owner}/${operator}`;

  if (!getBooleanValue(approved)) {
    await NftOperatorApproval.remove(id);

    return;
  }

  if (await NftOperatorApproval.get(id)) {
    return;
  }

  await Promise.all([
    ledgerAccount(owner, blockId, blockTime(block), blockEventId),
    ledgerAccount(operator, blockId, blockTime(block), blockEventId),
  ]);

  await NftOperatorApproval.create({
    id,
    assetId,
    ownerId: owner,
    operatorId: operator,
    createdEventId: blockEventId,
  }).save();
};
