import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { Distribution, Portfolio } from '../types';
import { getAssetId } from './assets';
import { extractNumber } from './common';

export interface MeshPortfolio {
  did: string;
  kind:
    | {
        user: number;
      }
    | { default: null };
}

export const meshPortfolioToPortfolio = (
  meshPortfolio: MeshPortfolio
): Pick<Portfolio, 'identityId' | 'number'> => {
  let number = 0;
  if ('user' in meshPortfolio.kind) {
    number = meshPortfolio.kind.user;
  }
  return {
    identityId: meshPortfolio.did,
    number: number || 0,
  };
};

export const getPortfolioValue = (item: Codec): Pick<Portfolio, 'identityId' | 'number'> => {
  const meshPortfolio = JSON.parse(item.toString());
  return meshPortfolioToPortfolio(meshPortfolio);
};

export const getPortfolioId = ({
  identityId,
  number,
}: Pick<Portfolio, 'identityId' | 'number'>): string => `${identityId}/${number}`;

export const getCaIdValue = (
  item: Codec,
  block: SubstrateBlock
): Pick<Distribution, 'localId' | 'assetId'> => {
  const caId = JSON.parse(item.toString());
  return {
    localId: extractNumber(caId, 'local_id'),
    assetId: getAssetId(caId.ticker ?? caId.assetId, block),
  };
};
