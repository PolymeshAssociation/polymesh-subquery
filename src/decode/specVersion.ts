/** `api.runtimeVersion.specName` of the Polymesh Private development chain */
export const PRIVATE_DEV_SPEC_NAME = 'polymesh_private_dev';

/**
 * How a `polymesh_private_dev` spec version maps onto the public chain's scale.
 *
 * The private chain restarted its spec numbering, so `7_000_000` and friends mean nothing there.
 * These three offsets were previously repeated inside `is7xChain`, `is7Dot3Chain` and
 * `is8xChain`; folding them here means a correction is one edit rather than four, and every
 * version comparison in the indexer - predicates and decoder lookups alike - agrees by
 * construction.
 *
 * The fourth band exists because two handlers treated *any* `polymesh_private_dev` version as
 * 6.0.0 or later. That is the same claim as "the private chain forked after 6.0.0", so it is
 * written here rather than left as a bare `specName` check in a handler body.
 *
 * The offsets themselves remain unverified against the private chain's release history.
 */
const PRIVATE_DEV_BANDS: readonly {
  from: number;
  publicSpecVersion: number;
  keepOffset: boolean;
}[] = [
  { from: 2_002_000, publicSpecVersion: 8_000_000, keepOffset: true },
  { from: 2_001_000, publicSpecVersion: 7_003_000, keepOffset: true },
  { from: 2_000_000, publicSpecVersion: 7_000_000, keepOffset: true },
  // Everything below the 7.x band collapses to 6.0.0: the private chain's own patch numbers
  // carry no information about which public release they correspond to
  { from: 0, publicSpecVersion: 6_000_000, keepOffset: false },
];

/**
 * A spec version on the public chain's scale.
 *
 * Apply this before any version comparison - a decoder lookup, a `>= 7_000_000` branch - so that
 * one range covers both chains.
 */
export const normaliseSpecVersion = (specVersion: number): number => {
  if (api.runtimeVersion.specName.toString() !== PRIVATE_DEV_SPEC_NAME) {
    return specVersion;
  }

  const band = PRIVATE_DEV_BANDS.find(({ from }) => specVersion >= from);

  if (!band) {
    return specVersion;
  }

  return band.keepOffset
    ? band.publicSpecVersion + (specVersion - band.from)
    : band.publicSpecVersion;
};
