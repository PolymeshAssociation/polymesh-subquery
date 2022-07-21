import { decodeAddress } from '@polkadot/keyring';
import { Codec } from '@polkadot/types/types';
import { hexStripPrefix, u8aToHex, u8aToString } from '@polkadot/util';
import { SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import { Portfolio } from 'polymesh-subql/types/models/Portfolio';
import {
  AssetDocument,
  Compliance,
  Distribution,
  FoundType,
  SecurityIdentifier,
  TransferComplianceExemption,
  TransferManager,
  TransferRestrictionTypeEnum,
} from '../types';
import { Attributes } from './entities/common';

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

export const removeNullChars = (s: string): string => s.replace(/\0/g, '');

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

export const serializeAccount = (item: Codec): string | null => {
  const s = item.toString();

  if (s.trim().length === 0) {
    return null;
  }
  return u8aToHex(decodeAddress(item.toString(), false, item.registry.chainSS58));
};

export const getFirstKeyFromJson = (item: Codec): string => {
  return Object.keys(item.toJSON())[0];
};

export const getFirstValueFromJson = (item: Codec): string => {
  return item.toJSON()[getFirstKeyFromJson(item)];
};

export const getTextValue = (item: Codec): string => {
  return item?.toString().trim().length === 0 ? null : item.toString().trim();
};

export const getNumberValue = (item: Codec): number => {
  return Number(getTextValue(item));
};

export const getDateValue = (item: Codec): Date => {
  return item.toString().trim().length === 0 ? null : new Date(Number(item.toString()));
};

export const getBigIntValue = (item: Codec): bigint => {
  return BigInt(getTextValue(item) || 0);
};

export const getBooleanValue = (item: Codec): boolean => {
  return JSON.parse(getTextValue(item));
};

export const hexToString = (input: string): string => {
  const hex = hexStripPrefix(input);
  let str = '';
  for (let i = 0; i < hex.length; i += 2)
    str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  return removeNullChars(str);
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
  const {
    uri: link,
    content_hash: documentHash,
    name,
    doc_type: type,
    filing_date: filedAt,
  } = JSON.parse(doc.toString());

  const hashType = Object.keys(documentHash)[0];

  return {
    name,
    link,
    contentHash: documentHash[hashType],
    type,
    filedAt,
  };
};

export const getSecurityIdentifiers = (item: Codec): SecurityIdentifier[] => {
  const identifiers = JSON.parse(item.toString());
  return identifiers.map(i => {
    const type = Object.keys(i)[0];
    return {
      type,
      value: i[type],
    };
  });
};

/**
 * Parses a Vec<AssetCompliance>
 */
export const getComplianceRulesValue = (
  requirements: Codec
): Pick<Compliance, 'complianceId' | 'data'>[] => {
  return JSON.parse(JSON.stringify(requirements));
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
    data,
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
    claimType,
  } = JSON.parse(item.toString());
  return {
    assetId: hexToString(ticker),
    opType,
    claimType,
  };
};

export const getExemptionsValue = (exemptions: Codec): string[] => {
  return JSON.parse(exemptions.toString()) || [];
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

interface MeshPortfolio {
  did: string;
  kind: {
    user: number;
  };
}

const meshPortfolioToPortfolio = ({
  did,
  kind: { user: number },
}: MeshPortfolio): Pick<Portfolio, 'identityId' | 'number'> => ({
  identityId: did,
  number: number || 0,
});

export const getPortfolioValue = (item: Codec): Pick<Portfolio, 'identityId' | 'number'> => {
  const meshPortfolio = JSON.parse(item.toString());
  return meshPortfolioToPortfolio(meshPortfolio);
};

export const getCaIdValue = (item: Codec): Pick<Distribution, 'localId' | 'assetId'> => {
  const { local_id: localId, ticker } = JSON.parse(item.toString());
  return { localId, assetId: hexToString(ticker) };
};

export interface LegDetails {
  from: Pick<Portfolio, 'identityId' | 'number'>;
  to: Pick<Portfolio, 'identityId' | 'number'>;
  ticker: string;
  amount: bigint;
}

export const getLegsValue = (item: Codec): LegDetails[] => {
  const legs = JSON.parse(item.toString());
  return legs.map(({ from: fromPortfolio, to: toPortfolio, asset: ticker, amount }) => ({
    from: meshPortfolioToPortfolio(fromPortfolio),
    to: meshPortfolioToPortfolio(toPortfolio),
    ticker: hexToString(ticker),
    amount: getBigIntValue(amount),
  }));
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
  const { from, currency, per_share, amount, remaining, payment_at, expires_at } = JSON.parse(
    item.toString()
  );
  const { identityId, number } = meshPortfolioToPortfolio(from);
  return {
    portfolioId: `${identityId}/${number}`,
    currency: hexToString(currency),
    perShare: getBigIntValue(per_share),
    amount: getBigIntValue(amount),
    remaining: getBigIntValue(remaining),
    paymentAt: getBigIntValue(payment_at),
    expiresAt: getBigIntValue(expires_at || END_OF_TIME),
  };
};
