/**
 * @returns a javascript object built using an `iterable` of keys and values.
 * Values are mapped by the map parameter
 */
export const fromEntries = <K, V, V2>(
  iterable: Iterable<[K, V]>,
  map: (v: V, i: number, k: K) => V2
) => {
  const res: any = {};

  let i = 0;
  for (const [k, v] of iterable) {
    res[k] = map(v, i, k);
    i++;
  }
  return res;
};

export const camelToSnakeCase = (str: string) =>
  str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

export const capitalizeFirstLetter = (str: string) =>
  str[0].toUpperCase() + str.slice(1);

export const removeNullChars = (s: string) => s.replace(/\0/g, "");

/**
 * @returns the index of the first top level comma in `text` which is a string with nested () and <>.
 * This is meant for rust types, for example "Map<Map<(u8,u32),String>,bool>"" would return 24.
 * @param text
 */
export const findTopLevelComma = (text: string): number => {
  let nestedLevel = 0;
  let i = 0;
  for (const char of text) {
    switch (char) {
      case "(":
      case "<": {
        nestedLevel++;
        break;
      }
      case ")":
      case ">": {
        nestedLevel--;
        break;
      }
      case ",": {
        if (nestedLevel === 1) {
          return i;
        }
      }
    }
    i++;
  }
  throw new Error(
    `No top level comma found in ${text}, it probably isn't a map`
  );
};
