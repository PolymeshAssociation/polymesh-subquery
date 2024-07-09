import { Codec } from '@polkadot/types/types';
import { Portfolio, Distribution } from '../types';
import { extractNumber, coerceHexToString } from './common';

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

export const getCaIdValue = (item: Codec): Pick<Distribution, 'localId' | 'assetId'> => {
  const caId = JSON.parse(item.toString());
  return {
    localId: extractNumber(caId, 'local_id'),
    assetId: coerceHexToString(caId.ticker),
  };
};
