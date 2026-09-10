import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { Distribution, HolderKind, Portfolio } from '../types';
import { getOrCreateAccount } from './accounts';
import { getAssetId } from './assets';
import { extractNumber, is8xChain } from './common';

/**
 * A resolved asset holder, carrying the grain it was resolved at.
 *
 * `holderKind` is the discriminator every downstream writer keys off — a `Holding` row, an
 * `AssetTransaction`'s from/to columns, the internal-transfer classification. It is set here,
 * at the one place a raw holder is parsed, so no consumer has to re-derive "portfolio or
 * account?" from the shape. `identityId` may still be empty/undefined for an account-grain
 * holder whose Identity is unknown — that is a *present* holder, not an absent one.
 */
export type AccountDetails = {
  identityId: string;
  account: string;
  holderKind: HolderKind.Account;
};
export type PortfolioDetails = Pick<Portfolio, 'identityId' | 'number'> & {
  holderKind: HolderKind.Portfolio;
};

export type AssetHolderDetails = AccountDetails | PortfolioDetails;

export const accountHolder = (identityId: string | undefined, account: string): AccountDetails => ({
  // typed `string` to match the rest of the codebase; genuinely undefined when the account's
  // Identity is unknown, which holder classification accounts for explicitly.
  identityId: identityId as string,
  account,
  holderKind: HolderKind.Account,
});

export const portfolioHolder = (identityId: string, number: number): PortfolioDetails => ({
  identityId,
  number,
  holderKind: HolderKind.Portfolio,
});

/**
 * Whether a movement is internal to one Identity — the shared classifier for
 * `AssetTransaction.isInternalTransfer`.
 *
 * Presence is checked before DID equality, and the order matters:
 *
 * - a missing `from` holder is an issuance, a missing `to` holder a redemption — neither is a
 *   transfer between two holders, so both return `undefined` rather than a boolean;
 * - a holder that is *present* but whose DID never resolved (an account with no known Identity)
 *   is not an absent holder. It classifies `false` — we cannot prove it is the same Identity,
 *   but it must never fall through to the issuance/redemption case and be recorded as one.
 *
 * `ControllerTransfer` is the case `eventId` alone cannot decide: nothing on chain stops its
 * source and destination resolving to the same DID, so it is classified here like any other.
 */
export const classifyInternalTransfer = (
  fromHolder: AssetHolderDetails | undefined,
  toHolder: AssetHolderDetails | undefined
): boolean | undefined => {
  if (!fromHolder || !toHolder) {
    return undefined;
  }
  if (!fromHolder.identityId || !toHolder.identityId) {
    return false;
  }
  return fromHolder.identityId === toHolder.identityId;
};

export interface MeshPortfolio {
  did: string;
  kind:
    | {
        user: number;
      }
    | { default: null }
    | { accountId: string };
}

export type MeshAssetHolder = { account: string } | { portfolio: MeshPortfolio };

/**
 * Till 7.4 chain, portfolio support all Default Portfolio, Numbered Portfolio and even account type portfolio
 */
export const meshPortfolioToAssetHolder = (meshPortfolio: MeshPortfolio): AssetHolderDetails => {
  let number = 0;

  // extract account address
  if ('accountId' in meshPortfolio.kind) {
    return accountHolder(meshPortfolio.did, meshPortfolio.kind.accountId);
  }
  // extract portfolio number
  if ('user' in meshPortfolio.kind) {
    number = meshPortfolio.kind.user;
  }
  return portfolioHolder(meshPortfolio.did, number || 0); // 0 maps to default portfolio
};

/**
 * Directly converts raw codec to AssetHolder type
 */
export const rawPortfolioToAssetHolder = (item: Codec): AssetHolderDetails => {
  const meshPortfolio = JSON.parse(item.toString());
  return meshPortfolioToAssetHolder(meshPortfolio);
};

/**
 * Convert parsed asset holder into AssetHolder
 * For account type asset holder, it fetches the did info from DB. If not present uses chain storage to figure out DID
 */

export const meshAssetHolderToAssetHolder = async (
  meshAssetHolder: MeshAssetHolder,
  blockId: string,
  datetime: Date
): Promise<AssetHolderDetails> => {
  if ('account' in meshAssetHolder) {
    const account = await getOrCreateAccount(meshAssetHolder.account, blockId, datetime);
    // `identityId` may be undefined here — an account with no known Identity is still a present
    // holder, and callers must classify on holder presence before DID equality.
    return accountHolder(account?.identityId, meshAssetHolder.account);
  }

  const { did, kind } = meshAssetHolder.portfolio;

  let number = 0;
  if ('user' in kind) {
    number = kind.user;
  }
  return portfolioHolder(did, number);
};

/**
 * Dual compatible method to deduce AssetHolder details
 * For 8.x chain, parses asset holder directly
 * For older chain, presumes that value is MeshPortfolio and parses as Portfolio
 */
export const extractAssetHolder = async (
  value: MeshAssetHolder | MeshPortfolio,
  block: SubstrateBlock,
  blockId: string
): Promise<AssetHolderDetails> => {
  if (is8xChain(block)) {
    return await meshAssetHolderToAssetHolder(value as MeshAssetHolder, blockId, block.timestamp);
  }
  return meshPortfolioToAssetHolder(value as MeshPortfolio);
};

/**
 * Dual compatible method to deduce AssetHolder details
 * For 8.x chain, parses asset holder directly
 * For older chain, presumes that value is MeshPortfolio and parses as Portfolio
 */
export const rawAssetHolderToAssetHolder = async (
  rawItem: Codec,
  block: SubstrateBlock,
  blockId: string
): Promise<AssetHolderDetails> => {
  const item = JSON.parse(rawItem.toString());
  return extractAssetHolder(item, block, blockId);
};

export const getPortfolioId = ({
  identityId,
  number,
}: Pick<Portfolio, 'identityId' | 'number'>): string => `${identityId}/${number}`;

export const getCaIdValue = async (
  item: Codec,
  block: SubstrateBlock
): Promise<Pick<Distribution, 'localId' | 'assetId'>> => {
  const caId = JSON.parse(item.toString());
  return {
    localId: extractNumber(caId, 'local_id'),
    assetId: await getAssetId(caId.ticker ?? caId.assetId, block),
  };
};
