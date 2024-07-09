import { Codec } from '@polkadot/types-codec/types';
import { Attributes } from '../mappings/entities/common';
import { Instruction, LegTypeEnum } from '../types';
import {
  capitalizeFirstLetter,
  extractBigInt,
  extractString,
  getBigIntValue,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  hexToString,
} from '../utils';
import { Leg } from './../types';
import { InstructionTypeEnum } from './../types/enums';
import { meshPortfolioToPortfolio } from './portfolios';

export type LegDetails = Omit<Attributes<Leg>, 'instructionId' | 'addresses'>;

export const getLegsValue = (item: Codec): LegDetails[] => {
  const legs: any[] = JSON.parse(item.toString());
  return legs.map(
    ({ from: rawFromPortfolio, to: rawToPortfolio, asset: ticker, amount }, legIndex) => {
      const { identityId: from, number: fromPortfolio } =
        meshPortfolioToPortfolio(rawFromPortfolio);
      const { identityId: to, number: toPortfolio } = meshPortfolioToPortfolio(rawToPortfolio);

      return {
        legIndex,
        from,
        fromPortfolio,
        to,
        toPortfolio,
        assetId: hexToString(ticker),
        amount: getBigIntValue(amount),
        legType: LegTypeEnum.Fungible,
      } as LegDetails;
    }
  );
};

export const getSettlementLeg = (item: Codec): LegDetails[] => {
  const legs: any[] = JSON.parse(item.toString());

  const legDetails: LegDetails[] = [];

  legs.forEach((leg, legIndex) => {
    const legTypeKey = Object.keys(leg)[0];
    const legValue = leg[legTypeKey];

    const legType = capitalizeFirstLetter(legTypeKey);
    let amount, nftIds;

    if (legType === LegTypeEnum.OffChain) {
      const from = extractString(legValue, 'sender_identity');
      const to = extractString(legValue, 'receiver_identity');
      const assetId = hexToString(legValue.ticker);
      const amount = extractBigInt(legValue, 'amount');

      legDetails.push({ from, to, amount, assetId, legIndex, legType: LegTypeEnum.OffChain });
    } else {
      const { identityId: from, number: fromPortfolio } = meshPortfolioToPortfolio(legValue.sender);
      const { identityId: to, number: toPortfolio } = meshPortfolioToPortfolio(legValue.receiver);

      let assetId: string;
      if (legType === LegTypeEnum.Fungible) {
        assetId = hexToString(legValue.ticker);
        amount = extractBigInt(legValue, 'amount');
      } else if (legType === LegTypeEnum.NonFungible) {
        assetId = hexToString(legValue.nfts.ticker);
        nftIds = leg.nonFungible.nfts.ids;
      }
      legDetails.push({
        from,
        fromPortfolio,
        to,
        toPortfolio,
        assetId,
        amount,
        legType: legType as LegTypeEnum,
        nftIds,
        legIndex,
      });
    }
  });

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
