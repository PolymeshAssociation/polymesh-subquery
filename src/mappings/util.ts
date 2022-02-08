import { decodeAddress } from '@polkadot/keyring';
import { Codec } from '@polkadot/types/types';
import { hexStripPrefix, u8aToHex, u8aToString } from '@polkadot/util';
import { SubstrateExtrinsic } from '@subql/types';
import { HarvesterLikeCallArgs } from './serializeLikeHarvester';
import { SecurityIdentifier, FoundType } from '../types';
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
  str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

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
  return item.toString().trim().length === 0 ? null : item.toString().trim();
};

export const hexToString = (input: string): string => {
  const hex = hexStripPrefix(input);
  let str = '';
  for (let i = 0; i < hex.length; i += 2)
    str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  return removeNullChars(str);
};

export const getSigner = (extrinsic: SubstrateExtrinsic): string => {
  const parsed = JSON.parse(extrinsic.extrinsic.toString());
  return u8aToHex(
    decodeAddress(parsed.signature.signer.id, false, extrinsic.block.registry.chainSS58)
  );
};

export const harvesterLikeParamsToObj = (
  params: HarvesterLikeCallArgs,
  formatKey = true
): Record<string, any> => {
  const obj: Record<string, any> = {};
  params.forEach(p => {
    obj[formatKey ? snakeToCamelCase(p.name) : p.name] =
      p.name === 'asset_type' ? Object.keys(p.value)[0] : p.value;
  });
  return obj;
};

export const formatAssetIdentifiers = (
  identifiers: Record<string, string>[]
): SecurityIdentifier[] =>
  identifiers.map(i => {
    const type = Object.keys(i)[0];
    return {
      type,
      value: i[type],
    };
  });

export const logFoundType = (type: string, rawType: string): void => {
  FoundType.create({ id: type, rawType }).save();
};
