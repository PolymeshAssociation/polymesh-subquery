import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { Distribution, Portfolio } from '../types';
import { getOrCreateAccount } from './accounts';
import { getAssetId } from './assets';
import { extractNumber, is8xChain } from './common';

export type AccountDetails = { identityId: string; account: string };
export type PortfolioDetails = Pick<Portfolio, 'identityId' | 'number'>;

export type AssetHolderDetails = AccountDetails | PortfolioDetails;

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
    return {
      identityId: meshPortfolio.did,
      account: meshPortfolio.kind.accountId,
    };
  }
  // extract portfolio number
  if ('user' in meshPortfolio.kind) {
    number = meshPortfolio.kind.user;
  }
  return {
    identityId: meshPortfolio.did,
    number: number || 0, // 0 maps to default portfolio
  };
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
    // @prashantasdeveloper need to confirm if we can safely assume that account will be present
    return { account: meshAssetHolder.account, identityId: account?.identityId };
  }

  const { did, kind } = meshAssetHolder.portfolio;

  let number = 0;
  if ('user' in kind) {
    number = kind.user;
  }
  return { identityId: did, number };
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
