import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { Account, Distribution, Portfolio } from '../types';
import { getAssetId } from './assets';
import { extractNumber, is8xChain } from './common';

export type PortfolioOrAccount =
  | { account: string; identityId?: string }
  | { identityId: string; number: number };
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

export const meshPortfolioToPortfolioOrAccount = (
  meshPortfolio: MeshPortfolio
): PortfolioOrAccount => {
  let number = 0;
  if ('accountId' in meshPortfolio.kind) {
    return {
      identityId: meshPortfolio.did,
      account: meshPortfolio.kind.accountId,
    };
  }
  if ('user' in meshPortfolio.kind) {
    number = meshPortfolio.kind.user;
  }
  return {
    identityId: meshPortfolio.did,
    number: number || 0,
  };
};

export const getPortfolioOrAccountValue = (item: Codec): PortfolioOrAccount => {
  const meshPortfolio = JSON.parse(item.toString());
  return meshPortfolioToPortfolioOrAccount(meshPortfolio);
};

export const meshAssetHolderToPortfolioOrAccount = async (
  meshAssetHolder: MeshAssetHolder
): Promise<PortfolioOrAccount> => {
  if ('account' in meshAssetHolder) {
    const account = await Account.get(meshAssetHolder.account);
    if (account) {
      return { identityId: account.identityId, account: meshAssetHolder.account };
    }
    return { account: meshAssetHolder.account };
  }

  const { did, kind } = meshAssetHolder.portfolio;

  let number = 0;
  if ('user' in kind) {
    number = kind.user;
  }
  return { identityId: did, number };
};

export const extractAccountOrPortfolio = async (
  value: MeshAssetHolder | MeshPortfolio,
  block: SubstrateBlock
): Promise<PortfolioOrAccount> => {
  if (is8xChain(block)) {
    return await meshAssetHolderToPortfolioOrAccount(value as MeshAssetHolder);
  }
  return meshPortfolioToPortfolioOrAccount(value as MeshPortfolio);
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
