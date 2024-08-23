import { Codec } from '@polkadot/types-codec/types';
import { SubstrateBlock } from '@subql/types';
import { Attributes } from '../mappings/entities/common';
import { Instruction, LegTypeEnum } from '../types';
import {
  capitalizeFirstLetter,
  extractBigInt,
  extractString,
  getAssetIdWithTicker,
  getBigIntValue,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  hexToString,
} from '../utils';
import { Leg } from './../types';
import { InstructionTypeEnum } from './../types/enums';
import { meshPortfolioToPortfolio } from './portfolios';

export type LegDetails = Omit<Attributes<Leg>, 'instructionId' | 'addresses'>;

/**
 * This only extracts legs for spec version < 6000000
 */
export const getLegsValue = async (item: Codec, block: SubstrateBlock): Promise<LegDetails[]> => {
  const legs: any[] = JSON.parse(item.toString());

  let legIndex = 0;
  const data: LegDetails[] = [];
  for (const leg of legs) {
    const { from: rawFromPortfolio, to: rawToPortfolio, amount } = leg;
    const { assetId, ticker } = await getAssetIdWithTicker(leg.asset, block);

    const { identityId: from, number: fromPortfolio } = meshPortfolioToPortfolio(rawFromPortfolio);
    const { identityId: to, number: toPortfolio } = meshPortfolioToPortfolio(rawToPortfolio);

    data.push({
      legIndex,
      from,
      fromPortfolio,
      to,
      toPortfolio,
      assetId,
      ticker,
      amount: getBigIntValue(amount),
      legType: LegTypeEnum.Fungible,
    });

    legIndex++;
  }
  return data;
};

export const getSettlementLeg = async (
  item: Codec,
  block: SubstrateBlock
): Promise<LegDetails[]> => {
  const legs: any[] = JSON.parse(item.toString());

  const legDetails: LegDetails[] = [];

  let legIndex = 0;
  for (const leg of legs) {
    const legTypeKey = Object.keys(leg)[0];
    const legValue = leg[legTypeKey];

    const legType = capitalizeFirstLetter(legTypeKey);
    let amount, nftIds;

    if (legType === LegTypeEnum.OffChain) {
      const from = extractString(legValue, 'sender_identity');
      const to = extractString(legValue, 'receiver_identity');
      const assetId = hexToString(legValue.ticker);
      const ticker = assetId;
      const amount = extractBigInt(legValue, 'amount');

      legDetails.push({
        from,
        to,
        amount,
        assetId,
        ticker,
        legIndex,
        legType: LegTypeEnum.OffChain,
      });
    } else {
      const { identityId: from, number: fromPortfolio } = meshPortfolioToPortfolio(legValue.sender);
      const { identityId: to, number: toPortfolio } = meshPortfolioToPortfolio(legValue.receiver);

      let assetId: string;
      let ticker: string;
      if (legType === LegTypeEnum.Fungible) {
        ({ assetId, ticker } = await getAssetIdWithTicker(
          legValue.ticker ?? legValue.assetId,
          block
        ));
        amount = extractBigInt(legValue, 'amount');
      } else if (legType === LegTypeEnum.NonFungible) {
        ({ assetId, ticker } = await getAssetIdWithTicker(
          legValue.nfts.ticker ?? legValue.nfts.assetId,
          block
        ));
        nftIds = leg.nonFungible.nfts.ids;
      }
      legDetails.push({
        from,
        fromPortfolio,
        to,
        toPortfolio,
        assetId,
        ticker,
        amount,
        legType: legType as LegTypeEnum,
        nftIds,
        legIndex,
      });
    }

    legIndex++;
  }

  return legDetails;
};

export const getSettlementTypeDetails = (
  item: Codec
): Pick<Instruction, 'type' | 'endBlock' | 'endAfterBlock'> => {
  const type = capitalizeFirstLetter(getFirstKeyFromJson(item));
  const value = getFirstValueFromJson(item);

  if (type === InstructionTypeEnum.SettleManual) {
    return {
      type,
      endAfterBlock: Number(value),
    };
  }

  if (type === InstructionTypeEnum.SettleOnBlock) {
    return {
      type,
      endBlock: Number(value),
    };
  }

  return {
    type: InstructionTypeEnum.SettleOnAffirmation,
  };
};
