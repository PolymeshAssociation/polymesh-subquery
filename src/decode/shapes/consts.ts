/**
 * Release-line boundaries on the public chain's spec-version scale.
 *
 * Spec versions read `aaa_bbb_ccd` for `vaaa.bbb.cc`, so a release line is a contiguous million.
 */
export const V6 = 6_000_000;
export const V7 = 7_000_000;
export const V7_3 = 7_003_000;
export const V8 = 8_000_000;

export const LAST_V5 = V6 - 1;
export const LAST_V7 = V8 - 1;
