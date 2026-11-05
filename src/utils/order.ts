/**
 * Code-unit order, as a plain `sort()` gives, stated so it reads as chosen: storage keys in hex sort
 * as the node orders them, and output doesn't depend on locale.
 */
export const byCodeUnit = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};
