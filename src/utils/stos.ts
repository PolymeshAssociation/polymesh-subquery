import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { Attributes } from '../mappings/entities/common';
import { Sto } from '../types';
import { getAssetId, getAssetIdWithTicker } from './assets';
import {
  capitalizeFirstLetter,
  extractBigInt,
  extractString,
  extractValue,
  getDateValue,
  hexToString,
} from './common';
import { getPortfolioId, meshPortfolioToPortfolio } from './portfolios';

export const getFundraiserDetails = async (
  item: Codec,
  block: SubstrateBlock
): Promise<Omit<Attributes<Sto>, 'stoId' | 'name'>> => {
  const { creator: creatorId, start, end, status, tiers, ...rest } = JSON.parse(item.toString());

  const offeringPortfolio = meshPortfolioToPortfolio(extractValue(rest, 'offering_portfolio'));
  const raisingPortfolio = meshPortfolioToPortfolio(extractValue(rest, 'raising_portfolio'));

  let stoStatus = status;
  if (typeof status !== 'string') {
    // for chain < 5.0.0, status comes as {'live': []}
    stoStatus = capitalizeFirstLetter(Object.keys(status)[0]);
  }

  const { assetId: raisingAssetId, ticker: raisingTicker } = await getAssetIdWithTicker(
    extractString(rest, 'raising_asset'),
    block
  );

  return {
    creatorId,
    status: stoStatus,
    start: getDateValue(start),
    end: getDateValue(end),
    tiers: tiers.map(tier => ({
      price: BigInt(tier.price),
      remaining: BigInt(tier.remaining),
      total: BigInt(tier.total),
    })),
    minimumInvestment: extractBigInt(rest, 'minimum_investment'),
    offeringAssetId: await getAssetId(extractString(rest, 'offering_asset'), block),
    offeringPortfolioId: getPortfolioId(offeringPortfolio),
    raisingAssetId,
    raisingTicker,
    raisingPortfolioId: getPortfolioId(raisingPortfolio),
    venueId: extractString(rest, 'venue_id'),
  };
};

export const getOfferingAsset = (item: Codec): string => {
  const fundraiser = JSON.parse(item.toString());
  return hexToString(extractValue(fundraiser, 'offering_asset'));
};

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export const extractOfferingAsset = (args: any[]) =>
  extractString(args[3]?.value, 'offering_asset');
