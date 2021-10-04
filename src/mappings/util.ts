import { Codec } from "@polkadot/types/types";
import { u8aToString } from "@polkadot/util";
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
  str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

export const capitalizeFirstLetter = (str: string): string =>
  str[0].toUpperCase() + str.slice(1);

export const removeNullChars = (s: string): string => s.replace(/\0/g, "");

/**
 * @returns the index of the first top level comma in `text` which is a string with nested () and <>.
 * This is meant for rust types, for example "Map<Map<(u8,u32),String>,bool>"" would return 24.
 * @param text
 */
export const findTopLevelCommas = (
  text: string,
  exitOnFirst = false
): number[] => {
  let nestedLevel = 0;
  const commas = [];
  let i = 0;

  for (const char of text) {
    switch (char) {
      case "(":
      case "{":
      case "<": {
        nestedLevel++;
        break;
      }
      case ")":
      case "}":
      case ">": {
        nestedLevel--;
        break;
      }
      case ",": {
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
    throw new Error(
      `No top level comma found in ${text}, it probably isn't a map`
    );
  }
  return commas;
};

export const getOrDefault = <K, V>(
  map: Map<K, V>,
  key: K,
  getDefault: () => V
): V => {
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
