import { decodeAddress } from '@polkadot/keyring';
import { Codec } from '@polkadot/types/types';
import { BN, hexHasPrefix, hexStripPrefix, isHex, u8aToHex, u8aToString } from '@polkadot/util';
import { SubstrateBlock, SubstrateExtrinsic } from '@subql/types';
import { Entity } from '@subql/types-core';
import { ErrorJson, FoundType } from '../types';
export const emptyDid = '0x00'.padEnd(66, '0');

const blockIdLength = 10;

/**
 * Left pad ID with 0 so that lexical order is equal to numeric order
 */
export const padId = (id: string): string => {
  return id.padStart(blockIdLength, '0');
};

/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
export const JSONStringifyExceptStringAndNull = (arg: any) => {
  if (arg !== undefined && arg !== null && typeof arg !== 'string') {
    return JSON.stringify(arg).replace(/(?:^")|(?:"$)/g, '');
  } else {
    return arg;
  }
};

/**
 * Function to get value for a specific key
 * It searches for snake_case and camelCase value for the given key
 */
export const extractValue = <T>(obj: unknown, key: string): T => {
  if (obj) {
    if (Object.keys(obj).includes(key)) {
      return obj[key] as T;
    }
    const camelCaseKey = snakeToCamelCase(key);
    if (Object.keys(obj).includes(camelCaseKey)) {
      return obj[camelCaseKey] as T;
    }
  }
  return undefined;
};

export const extractString = (obj: unknown, key: string): string => extractValue<string>(obj, key);

export const extractNumber = (obj: unknown, key: string): number => extractValue<number>(obj, key);

export const extractBigInt = (obj: unknown, key: string): bigint => extractValue<bigint>(obj, key);

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

export const getDateValue = (item: Codec): Date | undefined => {
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

export const logFoundType = (type: string, rawType: string): void => {
  FoundType.create({ id: type, rawType }).save();
};

export const END_OF_TIME = BigInt('253402194600000');

export function addIfNotIncludes<T>(arr: T[], item: T): void {
  if (!arr.includes(item)) {
    arr.push(item);
  }
}

export function removeIfIncludes<T>(arr: T[], item: T): void {
  if (arr.includes(item)) {
    const index = arr.indexOf(item);
    arr.splice(index);
  }
}

export const getSignerAddress = (extrinsic: SubstrateExtrinsic): string => {
  let signer: string;
  if (extrinsic) {
    signer = extrinsic.extrinsic.signer.toString();
  }
  return signer;
};

export const logError = (message: string): void => {
  logger.error(message);
};

export const bytesToString = (item: Codec): string => {
  const value = getTextValue(item);
  if (isHex(value)) {
    return hexToString(value);
  }
  if (value) {
    return removeNullChars(value);
  }
  return undefined;
};

export const getStringArrayValue = (item: Codec): string[] => {
  const set = JSON.parse(item.toString());

  return set;
};

export const getErrorDetails = (item: Codec): ErrorJson => {
  const dispatchError = JSON.parse(item.toString());

  if ('module' in dispatchError) {
    const { index, error } = dispatchError.module;

    const metaError = {
      index: new BN(index, 10),
      error: new BN(hexStripPrefix(error), 'hex', 'le'),
    };

    const { docs, name, section } = api.registry.findMetaError(metaError);
    return { errorType: `${section}.${name}`, details: docs.join('\n') };
  }

  const errorType = Object.keys(dispatchError)[0];

  let details: string;
  if (typeof dispatchError[errorType] === 'string') {
    details = dispatchError[errorType];
  } else {
    details = Object.keys(dispatchError[errorType])[0];
  }

  return {
    errorType: capitalizeFirstLetter(errorType),
    details,
  };
};

export const is7xChain = (block: SubstrateBlock) => {
  const { specVersion } = block;
  const specName = api.runtimeVersion.specName.toString();
  return specVersion >= 7000000 || (specName === 'polymesh_private_dev' && specVersion >= 2000000);
};

/**
 * From the spec version 7.3, sto events were modified to include asset ID details
 */
export const is7Dot3Chain = (block: SubstrateBlock) => {
  const { specVersion } = block;
  const specName = api.runtimeVersion.specName.toString();
  return specVersion >= 7003000 || (specName === 'polymesh_private_dev' && specVersion >= 2001000);
};

export const is8xChain = (block: SubstrateBlock) => {
  const { specVersion } = block;
  const specName = api.runtimeVersion.specName.toString();
  return specVersion >= 8000000 || (specName === 'polymesh_private_dev' && specVersion >= 2002000);
};

/**
 * Extracts the amount from 8.x chain staking event parameters.
 *
 * On 8.x chain, staking events have different parameter structures:
 * - Bonded/Unbonded: [stash, amount] (2 params)
 * - Rewarded: [stash, dest, amount] (3 params, dest is RewardDestination enum)
 *
 * This function detects if the second param is numeric (amount) or an enum (RewardDestination),
 * and returns the amount from the appropriate position.
 *
 * @param rawSecondParam - The second parameter (could be amount or RewardDestination)
 * @param rawThirdParam - The third parameter (amount for Rewarded events), optional
 * @returns The amount as bigint
 */
export const extract8xStakingAmount = (rawSecondParam: Codec, rawThirdParam?: Codec): bigint => {
  const secondParamText = getTextValue(rawSecondParam);
  const isSecondParamNumeric = /^\d+$/.test(secondParamText);

  if (isSecondParamNumeric) {
    return getBigIntValue(rawSecondParam);
  } else if (rawThirdParam) {
    return getBigIntValue(rawThirdParam);
  }
  return BigInt(0);
};

export const getPaginatedData = async <T extends Entity, F extends keyof T>(
  entityName: string,
  field: F,
  param: T[F]
): Promise<T[]> => {
  let offset = 0;
  const result: T[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await store.getByField<T>(entityName, field, param, {
      limit: 100,
      offset,
      orderBy: field,
      orderDirection: 'ASC',
    });

    result.push(...data);

    if (data.length < 100) {
      break;
    }

    offset += data.length;
  }
  return result;
};
