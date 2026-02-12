import { Codec } from '@polkadot/types/types';
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
import { getPortfolioOrAccountValue, meshPortfolioToPortfolioOrAccount } from './portfolios';

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

    const fromData = meshPortfolioToPortfolioOrAccount(rawFromPortfolio);
    const toData = meshPortfolioToPortfolioOrAccount(rawToPortfolio);

    let fromAccount: string | undefined, toAccount: string | undefined; // for accounts
    let from: string, to: string; // for dids

    let fromPortfolio: number | undefined, toPortfolio: number | undefined;
    if ('accountId' in fromData) {
      ({ accountId: fromAccount, identityId: from } = fromData);
    } else {
      ({ identityId: from, number: fromPortfolio } = fromData);
    }
    if ('accountId' in toData) {
      ({ accountId: toAccount, identityId: to } = toData);
    } else {
      ({ identityId: to, number: toPortfolio } = toData);
    }

    data.push({
      legIndex,
      from,
      fromPortfolio,
      fromAccount,
      to,
      toPortfolio,
      toAccount,
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
      const fromData = meshPortfolioToPortfolioOrAccount(legValue.sender);
      const toData = meshPortfolioToPortfolioOrAccount(legValue.receiver);

      let from: string, to: string;
      let fromAccount: string | undefined, toAccount: string | undefined;
      let fromPortfolio: number | undefined, toPortfolio: number | undefined;

      if ('accountId' in fromData) {
        ({ accountId: fromAccount, identityId: from } = fromData);
      } else {
        ({ identityId: from, number: fromPortfolio } = fromData);
      }
      if ('accountId' in toData) {
        ({ accountId: toAccount, identityId: to } = toData);
      } else {
        ({ identityId: to, number: toPortfolio } = toData);
      }

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
        fromAccount,
        to,
        toPortfolio,
        toAccount,
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

  if (type === InstructionTypeEnum.SettleAfterLock) {
    return {
      type: InstructionTypeEnum.SettleAfterLock,
    };
  }

  return {
    type: InstructionTypeEnum.SettleOnAffirmation,
  };
};

export const getPortfolioOrAccount = (
  rawPortfolio: Codec
): { identity: string; account?: string; portfolio?: number } => {
  const data = getPortfolioOrAccountValue(rawPortfolio);
  let account: string | undefined;
  let portfolio: number | undefined;
  let identityId: string;
  if ('accountId' in data) {
    ({ accountId: account, identityId } = data);
  } else {
    ({ identityId, number: portfolio } = data);
  }

  return {
    account,
    portfolio,
    identity: identityId,
  };
};
