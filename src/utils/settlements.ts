import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { Attributes } from '../mappings/entities/common';
import { Asset, Instruction, LegTypeEnum } from '../types';
import {
  capitalizeFirstLetter,
  extractBigInt,
  extractString,
  getAssetIdWithTicker,
  getBigIntValue,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  hexToString,
  padId,
} from '../utils';
import { Leg } from './../types';
import { InstructionTypeEnum } from './../types/enums';
import { AssetIdWithTicker } from './assets';
import {
  AssetHolderDetails,
  extractAssetHolder,
  getPortfolioId,
  meshPortfolioToAssetHolder,
} from './portfolios';

export type LegDetails = Omit<Attributes<Leg>, 'instructionId' | 'addresses'>;

/** One party to an instruction: an identity, whatever portfolios and accounts it holds through. */
export interface PartyDetails {
  identityId: string;
}

export type LegSides = Pick<
  LegDetails,
  'fromId' | 'fromAccountId' | 'fromPortfolioId' | 'toId' | 'toAccountId' | 'toPortfolioId'
>;

/** A holder on an instruction: a portfolio (`did/number`) or an account, with its identity. */
export interface HolderRef {
  identityId?: string;
  portfolioId?: string;
  accountId?: string;
}

/** The id of a holder's approval of an instruction: one row per (instruction, holder). */
export const holderAffirmationId = (instructionId: string, holder: HolderRef): string =>
  `${instructionId}/${holder.accountId ?? holder.portfolioId}`;

/** The id of a mediator's approval of an instruction. */
export const mediatorAffirmationId = (instructionId: string, did: string): string =>
  `${instructionId}/mediator/${did}`;

/**
 * The distinct on-chain holders across both sides of every leg, in first-seen order. An off-chain
 * leg's sides name an identity but no portfolio or account, so they hold nothing on chain.
 */
export const holdersOfLegs = (legs: LegSides[]): HolderRef[] => {
  const holders = new Map<string, HolderRef>();
  legs.forEach(leg => {
    [
      { identityId: leg.fromId, portfolioId: leg.fromPortfolioId, accountId: leg.fromAccountId },
      { identityId: leg.toId, portfolioId: leg.toPortfolioId, accountId: leg.toAccountId },
    ].forEach(holder => {
      const key = holder.accountId ?? holder.portfolioId;
      if (key && !holders.has(key)) {
        holders.set(key, holder);
      }
    });
  });
  return [...holders.values()];
};

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
const readLeg = async (
  leg: any,
  legIndex: number,
  { assetOf, isAsset: assetExists }: LegLookups
): Promise<LegDetails> => {
  const { from: rawFromPortfolio, to: rawToPortfolio, amount } = leg;
  const { assetId, ticker } = await assetOf(leg.asset);
  // a leg of a ticker that is no asset moved nothing on chain and was settled with a receipt;
  // 6.0's migration made each one an off-chain leg, as the chain has held it since
  const isAsset = await assetExists(assetId);

  return {
    legIndex,
    ...legSides(
      meshPortfolioToAssetHolder(rawFromPortfolio),
      meshPortfolioToAssetHolder(rawToPortfolio)
    ),
    assetId: isAsset ? assetId : undefined,
    ticker,
    amount: getBigIntValue(amount),
    legType: isAsset ? LegTypeEnum.Fungible : LegTypeEnum.OffChain,
  };
};

/**
 * The parties of an instruction's legs, by identity. A side whose account has no identity in the
 * index is no party: the chain requires one, so its creation reports it (`holdersOfLegs`).
 */
export const instructionPartiesOf = (legs: LegSides[]): Map<string, PartyDetails> => {
  const parties = new Map<string, PartyDetails>();
  legs.forEach(leg => {
    [leg.fromId, leg.toId].forEach(identityId => {
      if (identityId && !parties.has(identityId)) {
        parties.set(identityId, { identityId });
      }
    });
  });
  return parties;
};

/**
 * This only extracts legs for spec version < 6000000
 */
export const getLegsValue = async (
  item: Codec,
  block: SubstrateBlock,
  lookups: LegLookups = storeLookups(block, padId(block.block.header.number.toString()))
): Promise<LegDetails[]> => {
  const legs: any[] = JSON.parse(item.toString());

  // legs are independent (each only looks up its own asset); order is preserved
  return Promise.all(legs.map((leg, legIndex) => readLeg(leg, legIndex, lookups)));
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

/**
 * How a leg's parties and asset are named: a holder from its storage form, an asset by id and
 * ticker. Handlers read the store; the seed reads the chain state it starts from.
 */
export interface LegLookups {
  holderOf(value: any): Promise<AssetHolderDetails>;
  assetOf(assetIdOrTicker: any): Promise<AssetIdWithTicker>;
  /** whether an asset exists under the id, which a pre-6.0 leg needn't name */
  isAsset(assetId: string): Promise<boolean>;
}

const storeLookups = (
  block: SubstrateBlock,
  blockId: string,
  blockEventId?: string
): LegLookups => ({
  holderOf: value => extractAssetHolder(value, block, blockId, blockEventId),
  assetOf: assetIdOrTicker => getAssetIdWithTicker(assetIdOrTicker, block),
  isAsset: async assetId => Boolean(await Asset.get(assetId)),
});

const processOnChainLeg = async (
  legValue: any,
  legType: LegTypeEnum,
  legIndex: number,
  { holderOf, assetOf }: LegLookups
): Promise<LegDetails> => {
  const fromData = await holderOf(legValue.sender);
  const toData = await holderOf(legValue.receiver);

  let assetId: string;
  let ticker: string;
  let amount, nftIds;

  if (legType === LegTypeEnum.Fungible) {
    ({ assetId, ticker } = await assetOf(legValue.ticker ?? legValue.assetId));
    amount = extractBigInt(legValue, 'amount');
  } else {
    ({ assetId, ticker } = await assetOf(legValue.nfts.ticker ?? legValue.nfts.assetId));
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
  blockEventId?: string,
  lookups: LegLookups = storeLookups(block, blockId, blockEventId)
): Promise<LegDetails[]> => {
  const legs: any[] = JSON.parse(item.toString());

  const legDetails: LegDetails[] = [];

  // in order: a handler's lookup creates the account a leg names, which a later leg may name too
  let legIndex = 0;
  for (const leg of legs) {
    const legTypeKey = Object.keys(leg)[0];
    const legValue = leg[legTypeKey];

    const legType = capitalizeFirstLetter(legTypeKey);

    if (legType === LegTypeEnum.OffChain) {
      legDetails.push(processOffChainLeg(legValue, legIndex));
    } else {
      legDetails.push(await processOnChainLeg(legValue, legType as LegTypeEnum, legIndex, lookups));
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
