import { hexToU8a } from '@polkadot/util';
import { holdReasonOf, parseHolds } from '../../scripts/lib/balanceParts';

/** Testnet's pallet names at spec 8000020, by index; 46 was `contracts`, which `revive` replaced */
const PALLETS = new Map([[17, 'Staking']]);

describe('parseHolds', () => {
  /**
   * Testnet 5Fpy… just before 25,152,521: a hold of 88,697,166 for the removed `contracts` pallet
   * (index 46), which today's metadata can't decode, and a `Staking` hold equal to its
   * `ledger.total` then.
   */
  it('reads a list the typed decode rejects, filing a removed pallet under Unknown', () => {
    const raw = hexToU8a(
      '0x082e004e6949050000000000000000000000001100694848abbb1500000000000000000000'
    );

    expect(parseHolds(raw, PALLETS)).toEqual([
      { reason: 'Unknown', amount: BigInt(88697166) },
      { reason: 'Staking', amount: BigInt('23895776708713') },
    ]);
  });

  it('throws on bytes that are not 18 per entry', () => {
    expect(() => parseHolds(hexToU8a('0x041100'), PALLETS)).toThrow("don't fit 1 entries");
  });
});

describe('holdReasonOf', () => {
  it('names a hold after its pallet, as the index does', () => {
    expect(holdReasonOf('Staking')).toBe('Staking');
    expect(holdReasonOf('Revive')).toBe('Revive');
    expect(holdReasonOf('Contracts')).toBe('Unknown');
    expect(holdReasonOf(undefined)).toBe('Unknown');
  });
});
