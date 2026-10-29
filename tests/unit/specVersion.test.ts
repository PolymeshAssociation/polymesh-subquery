import { SubstrateBlock } from '@subql/types';
import { normaliseSpecVersion } from '../../src/decode';
import { is7Dot3Chain, is7xChain, is8xChain, specVersionOf } from '../../src/utils';

const setSpecName = (specName: string) => {
  (api.runtimeVersion.specName as any).toString = () => specName;
};

const blockAt = (specVersion: number) => ({ specVersion } as SubstrateBlock);

describe('normaliseSpecVersion', () => {
  it('leaves the public chain alone', () => {
    setSpecName('polymesh');

    expect(normaliseSpecVersion(7_004_001)).toBe(7_004_001);
  });

  it.each([
    ['7.0 band', 2_000_000, 7_000_000],
    ['within the 7.0 band', 2_000_500, 7_000_500],
    ['7.3 band', 2_001_000, 7_003_000],
    ['8.0 band', 2_002_000, 8_000_000],
    ['within the 8.0 band', 2_002_002, 8_000_002],
  ])('maps the private chain %s onto the public scale', (_label, privateVersion, expected) => {
    setSpecName('polymesh_private_dev');

    expect(normaliseSpecVersion(privateVersion)).toBe(expected);
  });

  it('reads a private version below the 7.x bands as 6.0.0, which is where that chain forked', () => {
    setSpecName('polymesh_private_dev');

    expect(normaliseSpecVersion(1_000_000)).toBe(6_000_000);
    expect(normaliseSpecVersion(1_005_000)).toBe(6_000_000);
  });
});

describe('version predicates', () => {
  it('answers the same way for the public chain as the raw comparison did', () => {
    setSpecName('polymesh');

    expect(is7xChain(blockAt(6_003_001))).toBe(false);
    expect(is7xChain(blockAt(7_000_000))).toBe(true);
    expect(is7Dot3Chain(blockAt(7_002_999))).toBe(false);
    expect(is7Dot3Chain(blockAt(7_003_003))).toBe(true);
    expect(is8xChain(blockAt(7_004_001))).toBe(false);
    expect(is8xChain(blockAt(8_000_000))).toBe(true);
  });

  it('applies the private chain offsets through one normalisation', () => {
    setSpecName('polymesh_private_dev');

    expect(is7xChain(blockAt(1_999_999))).toBe(false);
    expect(is7xChain(blockAt(2_000_000))).toBe(true);
    expect(is7Dot3Chain(blockAt(2_000_999))).toBe(false);
    expect(is7Dot3Chain(blockAt(2_001_000))).toBe(true);
    expect(is8xChain(blockAt(2_001_999))).toBe(false);
    expect(is8xChain(blockAt(2_002_000))).toBe(true);
  });

  it('reads a private chain block as at least 6.0.0, which handlers relied on a specName check for', () => {
    setSpecName('polymesh_private_dev');

    expect(specVersionOf(blockAt(1_000_000))).toBeGreaterThanOrEqual(6_000_000);
    expect(specVersionOf(blockAt(2_002_000))).toBeGreaterThanOrEqual(6_000_000);
  });
});
