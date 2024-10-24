import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { Distribution } from 'src/types';
import { getAssetId } from './assets';
import { END_OF_TIME, extractBigInt, getBigIntValue } from './common';
import { meshPortfolioToPortfolio } from './portfolios';

export const getDistributionValue = async (
  item: Codec,
  block: SubstrateBlock
): Promise<
  Pick<
    Distribution,
    'portfolioId' | 'currencyId' | 'perShare' | 'amount' | 'remaining' | 'paymentAt' | 'expiresAt'
  >
> => {
  const { from, currency, amount, remaining, ...rest } = JSON.parse(item.toString());
  const { identityId, number } = meshPortfolioToPortfolio(from);
  return {
    portfolioId: `${identityId}/${number}`,
    currencyId: await getAssetId(currency, block),
    perShare: BigInt(extractBigInt(rest, 'per_share') || 0),
    amount: getBigIntValue(amount),
    remaining: getBigIntValue(remaining),
    paymentAt: BigInt(extractBigInt(rest, 'payment_at') || 0),
    expiresAt: BigInt(extractBigInt(rest, 'expires_at') || END_OF_TIME),
  };
};

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export const extractCorporateActionTicker = (args: any[]) => {
  const value1AssetId = args[1]?.value?.ticker ?? args[1]?.value?.assetId;
  if (value1AssetId !== undefined) {
    return value1AssetId;
  }
  const value2AssetId = args[2]?.value?.ticker ?? args[2]?.value?.assetId;
  if (value2AssetId !== undefined) {
    return value2AssetId;
  }
  return null;
};
