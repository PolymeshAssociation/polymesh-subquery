import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { LegTypeEnum } from '../types';
import { getAssetIdWithTicker } from './assets';
import { MeshPortfolio, meshPortfolioToAssetHolder } from './portfolios';
import { LegDetails, legSides } from './settlements';

/** JSON of v5.3's `LegV2`, the legs of `InstructionV2Created` (testnet only) */
interface LegV2 {
  from: MeshPortfolio;
  to: MeshPortfolio;
  asset:
    | { fungible: { ticker: string; amount: number | string } }
    | { nonFungible: { ticker: string; ids: (number | string)[] } };
}

const legV2Asset = ({
  asset,
}: LegV2): Pick<LegDetails, 'amount' | 'nftIds' | 'legType'> & {
  ticker: string;
} =>
  'fungible' in asset
    ? {
        ticker: asset.fungible.ticker,
        amount: BigInt(asset.fungible.amount),
        legType: LegTypeEnum.Fungible,
      }
    : {
        ticker: asset.nonFungible.ticker,
        nftIds: asset.nonFungible.ids.map(BigInt),
        legType: LegTypeEnum.NonFungible,
      };

export const getLegV2Values = async (item: Codec, block: SubstrateBlock): Promise<LegDetails[]> => {
  const legs = item.toJSON() as unknown as LegV2[];

  return Promise.all(
    legs.map(async (leg, legIndex) => {
      const { ticker: rawTicker, ...asset } = legV2Asset(leg);
      const { assetId, ticker } = await getAssetIdWithTicker(rawTicker, block);
      return {
        legIndex,
        ...legSides(meshPortfolioToAssetHolder(leg.from), meshPortfolioToAssetHolder(leg.to)),
        assetId,
        ticker,
        ...asset,
      };
    })
  );
};
