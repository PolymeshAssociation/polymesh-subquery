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
import {
  AssetHolderDetails,
  extractAssetHolder,
  getPortfolioId,
  meshPortfolioToAssetHolder,
} from './portfolios';

export type LegDetails = Omit<Attributes<Leg>, 'instructionId' | 'addresses'>;

/** One party to an instruction: an identity, or an account holder with no identity. */
export interface PartyDetails {
  identityId?: string;
  /** set only when there is no identity */
  accountId?: string;
}

type LegSides = Pick<
  LegDetails,
  'fromId' | 'fromAccountId' | 'fromPortfolioId' | 'toId' | 'toAccountId' | 'toPortfolioId'
>;

/** The number of a portfolio id (`did/number`). */
export const portfolioNumber = (portfolioId: string): number => Number(portfolioId.split('/')[1]);

/** One side of a leg: its identity, and its account or portfolio. */
const holderFields = (
  holder: AssetHolderDetails
): { id?: string; accountId?: string; portfolioId?: string } =>
  'account' in holder
    ? { id: holder.identityId || undefined, accountId: holder.account }
    : { id: holder.identityId, portfolioId: getPortfolioId(holder) };

export const legSides = (from: AssetHolderDetails, to: AssetHolderDetails): LegSides => {
  const sender = holderFields(from);
  const receiver = holderFields(to);
  return {
    fromId: sender.id,
    fromAccountId: sender.accountId,
    fromPortfolioId: sender.portfolioId,
    toId: receiver.id,
    toAccountId: receiver.accountId,
    toPortfolioId: receiver.portfolioId,
  };
};

/** One pre-v6 leg, as `getLegsValue` reads it. */
const readLeg = async (leg: any, legIndex: number, block: SubstrateBlock): Promise<LegDetails> => {
  const { from: rawFromPortfolio, to: rawToPortfolio, amount } = leg;
  const { assetId, ticker } = await getAssetIdWithTicker(leg.asset, block);

  return {
    legIndex,
    ...legSides(
      meshPortfolioToAssetHolder(rawFromPortfolio),
      meshPortfolioToAssetHolder(rawToPortfolio)
    ),
    assetId,
    ticker,
    amount: getBigIntValue(amount),
    legType: LegTypeEnum.Fungible,
  };
};

/** The parties of an instruction's legs, keyed as `getPartyId` keys them: by DID, else account. */
export const instructionPartiesOf = (legs: LegSides[]): Map<string, PartyDetails> => {
  const parties = new Map<string, PartyDetails>();
  const add = (identityId?: string, accountId?: string): void => {
    const key = identityId ?? accountId;
    if (key && !parties.has(key)) {
      parties.set(key, { identityId, accountId: identityId ? undefined : accountId });
    }
  };
  legs.forEach(leg => {
    add(leg.fromId, leg.fromAccountId);
    add(leg.toId, leg.toAccountId);
  });
  return parties;
};

/**
 * This only extracts legs for spec version < 6000000
 */
export const getLegsValue = async (item: Codec, block: SubstrateBlock): Promise<LegDetails[]> => {
  const legs: any[] = JSON.parse(item.toString());

  // legs are independent (each only reads the store for its own asset); order is preserved
  return Promise.all(legs.map((leg, legIndex) => readLeg(leg, legIndex, block)));
};

const processOffChainLeg = (legValue: any, legIndex: number): LegDetails => ({
  fromId: extractString(legValue, 'sender_identity'),
  toId: extractString(legValue, 'receiver_identity'),
  amount: extractBigInt(legValue, 'amount'),
  assetId: undefined,
  ticker: hexToString(legValue.ticker),
  legIndex,
  legType: LegTypeEnum.OffChain,
});

/** Test hook. */
export const processOffChainLegForTest = processOffChainLeg;

const processOnChainLeg = async (
  legValue: any,
  legType: LegTypeEnum,
  legIndex: number,
  block: SubstrateBlock,
  blockId: string,
  blockEventId?: string
): Promise<LegDetails> => {
  const fromData = await extractAssetHolder(legValue.sender, block, blockId, blockEventId);
  const toData = await extractAssetHolder(legValue.receiver, block, blockId, blockEventId);

  let assetId: string;
  let ticker: string;
  let amount, nftIds;

  if (legType === LegTypeEnum.Fungible) {
    ({ assetId, ticker } = await getAssetIdWithTicker(legValue.ticker ?? legValue.assetId, block));
    amount = extractBigInt(legValue, 'amount');
  } else {
    ({ assetId, ticker } = await getAssetIdWithTicker(
      legValue.nfts.ticker ?? legValue.nfts.assetId,
      block
    ));
    nftIds = legValue.nfts.ids;
  }
  return {
    ...legSides(fromData, toData),
    assetId,
    ticker,
    amount,
    legType,
    nftIds,
    legIndex,
  };
};

export const getSettlementLeg = async (
  item: Codec,
  block: SubstrateBlock,
  blockId: string,
  blockEventId?: string
): Promise<LegDetails[]> => {
  const legs: any[] = JSON.parse(item.toString());

  const legDetails: LegDetails[] = [];

  let legIndex = 0;
  for (const leg of legs) {
    const legTypeKey = Object.keys(leg)[0];
    const legValue = leg[legTypeKey];

    const legType = capitalizeFirstLetter(legTypeKey);

    if (legType === LegTypeEnum.OffChain) {
      legDetails.push(processOffChainLeg(legValue, legIndex));
    } else {
      legDetails.push(
        await processOnChainLeg(
          legValue,
          legType as LegTypeEnum,
          legIndex,
          block,
          blockId,
          blockEventId
        )
      );
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

export const getPortfolioOrAccount = async (
  rawItem: Codec,
  block: SubstrateBlock,
  blockId: string,
  blockEventId?: string
): Promise<{
  identityId: string;
  accountId?: string;
  portfolio?: number;
  portfolioId?: string;
}> => {
  const item = JSON.parse(rawItem.toString());
  const data = await extractAssetHolder(item, block, blockId, blockEventId);
  if ('account' in data) {
    return { identityId: data.identityId, accountId: data.account };
  }
  return { identityId: data.identityId, portfolio: data.number, portfolioId: getPortfolioId(data) };
};
