import { decodeAddress, encodeAddress } from '@polkadot/keyring';
import { Codec } from '@polkadot/types/types';
import { hexHasPrefix, hexStripPrefix, isHex, u8aToHex, u8aToString } from '@polkadot/util';
import { SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import {
  AssetDocument,
  ClaimTypeEnum,
  Compliance,
  Distribution,
  FoundType,
  LegTypeEnum,
  Portfolio,
  SecurityIdentifier,
  Sto,
  TransferComplianceExemption,
  TransferManager,
  TransferRestrictionTypeEnum,
} from '../types';
import { Attributes } from './entities/common';
import { extractValue, extractString, extractBigInt, extractNumber } from './generatedColumns';

export const emptyDid = '0x00'.padEnd(66, '0');

/**
 * @returns a javascript object built using an `iterable` of keys and values.
 * Values are mapped by the map parameter
 */
export const fromEntries = <K extends string | number, V, V2>(
  iterable: Iterable<[K, V]>,
  map: (v: V, i: number, k: K) => V2
): Partial<Record<K, V2>> => {
  const res: Partial<Record<K, V2>> = {};

  let i = 0;
  for (const [k, v] of iterable) {
    res[k] = map(v, i, k);
    i++;
  }
  return res;
};

export const camelToSnakeCase = (str: string): string =>
  str[0].toLowerCase() + str.slice(1).replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

export const snakeToCamelCase = (value: string): string =>
  value
    .toLowerCase()
    .replace(/([-_][a-z])/g, group => group.toUpperCase().replace('-', '').replace('_', ''));

export const capitalizeFirstLetter = (str: string): string => str[0].toUpperCase() + str.slice(1);

export const removeNullChars = (s?: string): string => s?.replace(/\0/g, '') || '';

/**
 * @returns the index of the first top level comma in `text` which is a string with nested () and <>.
 * This is meant for rust types, for example "Map<Map<(u8,u32),String>,bool>"" would return 24.
 * @param text
 */
export const findTopLevelCommas = (text: string, exitOnFirst = false): number[] => {
  let nestedLevel = 0;
  const commas = [];
  let i = 0;

  for (const char of text) {
    switch (char) {
      case '(':
      case '{':
      case '<': {
        nestedLevel++;
        break;
      }
      case ')':
      case '}':
      case '>': {
        nestedLevel--;
        break;
      }
      case ',': {
        if (nestedLevel === 1) {
          if (exitOnFirst) {
            return [i];
          } else {
            commas.push(i);
          }
        }
      }
    }
    i++;
  }
  if (commas.length === 0) {
    throw new Error(`No top level comma found in ${text}, it probably isn't a map`);
  }
  return commas;
};

export const getOrDefault = <K, V>(map: Map<K, V>, key: K, getDefault: () => V): V => {
  const v = map.get(key);
  if (v !== undefined) {
    return v;
  } else {
    const def = getDefault();
    map.set(key, def);
    return def;
  }
};

export const serializeTicker = (item: Codec): string => {
  return removeNullChars(u8aToString(item.toU8a()));
};

export const serializeAccount = (item: Codec): string | undefined => {
  const s = item.toString();

  if (s.trim().length === 0) {
    return undefined;
  }
  return u8aToHex(decodeAddress(item.toString(), false, item.registry.chainSS58));
};

export const getAccountKey = (item: string, ss58Format?: number): string => {
  return encodeAddress(item.toString(), ss58Format);
};

export const getFirstKeyFromJson = (item: Codec): string => {
  return Object.keys(item.toJSON())[0];
};

export const getFirstValueFromJson = (item: Codec): string => {
  return item.toJSON()[getFirstKeyFromJson(item)];
};

export const getTextValue = (item: Codec): string => {
  return item?.toString().trim().length > 0 ? item.toString().trim() : undefined;
};

export const getNumberValue = (item: Codec): number => {
  return Number(getTextValue(item));
};

export const getDateValue = (item: Codec): Date => {
  return item?.toString().trim().length > 0 ? new Date(Number(item.toString())) : undefined;
};

export const getBigIntValue = (item: Codec): bigint => {
  return BigInt(getTextValue(item) || 0);
};

export const getBooleanValue = (item: Codec): boolean => {
  return JSON.parse(getTextValue(item) || 'false');
};

export const hexToString = (input: string): string => {
  const hex = hexStripPrefix(input);
  let str = '';
  for (let i = 0; i < hex.length; i += 2)
    str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  return removeNullChars(str);
};

/**
 * If given string that begins with "0x", this method will create a string from its binary representation.
 * Otherwise it returns the string as it is.
 *
 * @example
 *   1. "0x424152" => "BAR"
 *   2. "FOO" => "FOO"
 */
export const coerceHexToString = (input: string): string => {
  if (hexHasPrefix(input)) {
    return hexToString(input);
  }
  return input;
};

export const getSigner = (extrinsic: SubstrateExtrinsic): string => {
  return hexStripPrefix(
    u8aToHex(
      decodeAddress(
        extrinsic.extrinsic.signer.toString(),
        false,
        extrinsic.extrinsic.registry.chainSS58
      )
    )
  );
};

/**
 * Parses a raw Asset Document
 */
export const getDocValue = (
  doc: Codec
): Pick<AssetDocument, 'name' | 'link' | 'contentHash' | 'type' | 'filedAt'> => {
  const document = JSON.parse(doc.toString());

  const documentHash = extractValue(document, 'content_hash');

  const hashType = Object.keys(documentHash)[0];
  const contentHash = {
    type: hashType,
    value: documentHash[hashType],
  };

  let filedAt;
  const filingDate = extractString(document, 'filing_date');
  if (filingDate) {
    filedAt = new Date(filingDate);
  }

  return {
    name: coerceHexToString(extractString(document, 'name')),
    link: coerceHexToString(extractString(document, 'uri')),
    contentHash,
    type: coerceHexToString(extractString(document, 'doc_type')),
    filedAt,
  };
};

export const getSecurityIdentifiers = (item: Codec): SecurityIdentifier[] => {
  const identifiers = JSON.parse(item.toString());
  return identifiers.map(i => {
    const type = Object.keys(i)[0];
    return {
      type,
      value: coerceHexToString(i[type]),
    };
  });
};

/**
 * Parses a Vec<AssetCompliance>
 */
export const getComplianceValues = (
  requirements: Codec
): Pick<Compliance, 'complianceId' | 'data'>[] => {
  const compliances = JSON.parse(requirements.toString());

  return compliances.map(({ id, ...data }) => ({
    complianceId: Number(id),
    data: JSON.stringify(data),
  }));
};

/**
 * Parses AssetCompliance
 */
export const getComplianceValue = (
  compliance: Codec
): Pick<Compliance, 'complianceId' | 'data'> => {
  const { id, ...data } = JSON.parse(compliance.toString());
  return {
    complianceId: Number(id),
    data: JSON.stringify(data),
  };
};

/**
 * Parses AssetTransferManager
 */
export const getTransferManagerValue = (
  manager: Codec
): Pick<TransferManager, 'type' | 'value'> => {
  const { countTransferManager, percentageTransferManager } = JSON.parse(JSON.stringify(manager));

  if (countTransferManager) {
    return {
      type: TransferRestrictionTypeEnum.Count,
      value: Number(countTransferManager),
    };
  }

  if (percentageTransferManager) {
    return {
      type: TransferRestrictionTypeEnum.Percentage,
      value: Number(percentageTransferManager),
    };
  }

  throw new Error('Unknown transfer restriction type found');
};

export const getExemptKeyValue = (
  item: Codec
): Omit<Attributes<TransferComplianceExemption>, 'exemptedEntityId'> => {
  const {
    asset: { ticker },
    op: opType,
    claimType: claimTypeValue,
  } = JSON.parse(item.toString());

  let claimType;
  if (!claimTypeValue || typeof claimTypeValue === 'string') {
    claimType = claimTypeValue;
  } else {
    // from 5.1.0 chain version, Custom(CustomClaimTypeId) was added to the ClaimTypeEnum, polkadot now reads values as {"accredited": undefined}
    claimType = capitalizeFirstLetter(Object.keys(claimTypeValue)[0]) as ClaimTypeEnum;
  }

  return {
    assetId: hexToString(ticker),
    opType,
    claimType,
  };
};

export const getExemptionsValue = (exemptions: Codec): string[] => {
  return exemptions.toJSON() as string[];
};

export const logFoundType = (type: string, rawType: string): void => {
  FoundType.create({ id: type, rawType }).save();
};

export const END_OF_TIME = BigInt('253402194600000');

export function addIfNotIncludes<T>(arr: T[], item: T): void {
  if (!arr.includes(item)) {
    arr.push(item);
  }
}

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

export interface LegDetails {
  from: Pick<Portfolio, 'identityId' | 'number'>;
  to: Pick<Portfolio, 'identityId' | 'number'>;
  ticker: string;
  amount: bigint;
  legType: LegTypeEnum;
}

export const getLegsValue = (item: Codec): LegDetails[] => {
  const legs = JSON.parse(item.toString());
  return legs.map(({ from: fromPortfolio, to: toPortfolio, asset: ticker, amount }) => ({
    from: meshPortfolioToPortfolio(fromPortfolio),
    to: meshPortfolioToPortfolio(toPortfolio),
    ticker: hexToString(ticker),
    amount: getBigIntValue(amount),
    legType: LegTypeEnum.Fungible,
  }));
};

export const getSettlementLeg = (item: Codec): LegDetails[] => {
  const legs = JSON.parse(item.toString());
  const legTypes = Object.keys(legs);
  if (legTypes.includes('NonFungible') || legTypes.includes('OffChain')) {
    return undefined;
  }
  return legs.map(leg => {
    let legType = Object.keys(leg)[0];
    const legValue = leg[legType];
    let from, to, ticker, amount;
    if (legType === 'fungible') {
      from = meshPortfolioToPortfolio(legValue.sender);
      to = meshPortfolioToPortfolio(legValue.receiver);
      ticker = hexToString(legValue.ticker);
      amount = extractBigInt(legValue, 'amount');
      legType = LegTypeEnum.Fungible;
    }
    return { from, to, ticker, amount, legType };
  });
};

export const getSignerAddress = (event: SubstrateEvent): string => {
  let signer: string;
  if (event.extrinsic) {
    signer = getSigner(event.extrinsic);
  }
  return signer;
};

export const getDistributionValue = (
  item: Codec
): Pick<
  Distribution,
  'portfolioId' | 'currency' | 'perShare' | 'amount' | 'remaining' | 'paymentAt' | 'expiresAt'
> => {
  const { from, currency, amount, remaining, ...rest } = JSON.parse(item.toString());
  const { identityId, number } = meshPortfolioToPortfolio(from);
  return {
    portfolioId: `${identityId}/${number}`,
    currency: hexToString(currency),
    perShare: BigInt(extractBigInt(rest, 'per_share') || 0),
    amount: getBigIntValue(amount),
    remaining: getBigIntValue(remaining),
    paymentAt: BigInt(extractBigInt(rest, 'payment_at') || 0),
    expiresAt: BigInt(extractBigInt(rest, 'expires_at') || END_OF_TIME),
  };
};

export const logError = (message: string): void => {
  logger.error(message);
};

export const getOfferingAsset = (item: Codec): string => {
  const fundraiser = JSON.parse(item.toString());
  return hexToString(extractValue(fundraiser, 'offering_asset'));
};

export const bytesToString = (item: Codec): string => {
  const value = getTextValue(item);
  if (isHex(value)) {
    return hexToString(value);
  }
  return removeNullChars(value);
};

export const getFundraiserDetails = (item: Codec): Omit<Attributes<Sto>, 'stoId' | 'name'> => {
  const { creator: creatorId, start, end, status, tiers, ...rest } = JSON.parse(item.toString());

  const offeringPortfolio = meshPortfolioToPortfolio(extractValue(rest, 'offering_portfolio'));
  const raisingPortfolio = meshPortfolioToPortfolio(extractValue(rest, 'raising_portfolio'));

  let stoStatus = status;
  if (typeof status !== 'string') {
    // for chain < 5.0.0, status comes as {'live': []}
    stoStatus = capitalizeFirstLetter(Object.keys(status)[0]);
  }

  return {
    creatorId,
    status: stoStatus,
    start: getDateValue(start),
    end: getDateValue(end),
    tiers,
    minimumInvestment: extractBigInt(rest, 'minimum_investment'),
    offeringAssetId: hexToString(extractString(rest, 'offering_asset')),
    offeringPortfolioId: getPortfolioId(offeringPortfolio),
    raisingAssetId: hexToString(extractString(rest, 'raising_asset')),
    raisingPortfolioId: getPortfolioId(raisingPortfolio),
    venueId: extractString(rest, 'venue_id'),
  };
};
