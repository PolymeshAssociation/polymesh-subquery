import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { Distribution, Portfolio } from '../types';
import { getAssetId } from './assets';
import { extractNumber } from './common';

export type PortfolioOrAccount = Pick<Portfolio, 'identityId'> &
  (Pick<Portfolio, 'number'> | { accountId: string });
export interface MeshPortfolio {
  did: string;
  kind:
    | {
        user: number;
      }
    | { default: null }
    | { accountId: string };
}

export const meshPortfolioToPortfolioOrAccount = (
  meshPortfolio: MeshPortfolio
): PortfolioOrAccount => {
  let number = 0;
  if ('accountId' in meshPortfolio.kind) {
    return {
      identityId: meshPortfolio.did,
      accountId: meshPortfolio.kind.accountId,
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
