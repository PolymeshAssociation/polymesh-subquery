import '@subql/types-core/dist/global';
import '@subql/types/dist/global';
import { shouldRescanAutomaticAffirmations } from '../../src/mappings/entities/settlements/mapSettlement';

/**
 * Regression tests for defect A4: the guard around the `InstructionAutomaticallyAffirmed`
 * re-scan folded its two conditions into a single `||`, so it evaluated true for every
 * non-private chain at any spec version and the re-scan ran on every mainnet/testnet block
 * instead of only on the 6.1.0–6.3.1 window it exists for.
 */
describe('shouldRescanAutomaticAffirmations', () => {
  it('runs only within the 6.1.0–6.3.1 window on public chains', () => {
    expect(shouldRescanAutomaticAffirmations('polymesh', 6001000)).toBe(true);
    expect(shouldRescanAutomaticAffirmations('polymesh', 6003001)).toBe(true);
    expect(shouldRescanAutomaticAffirmations('polymesh', 6002000)).toBe(true);
  });

  it('does not run before 6.1.0 or after 6.3.1', () => {
    expect(shouldRescanAutomaticAffirmations('polymesh', 6000999)).toBe(false);
    expect(shouldRescanAutomaticAffirmations('polymesh', 6003002)).toBe(false);
    expect(shouldRescanAutomaticAffirmations('polymesh', 7000000)).toBe(false);
  });

  it('does not run at spec 8_000_000', () => {
    expect(shouldRescanAutomaticAffirmations('polymesh', 8000000)).toBe(false);
  });

  it('never runs on polymesh_private_dev, whatever its spec version', () => {
    expect(shouldRescanAutomaticAffirmations('polymesh_private_dev', 6002000)).toBe(false);
    expect(shouldRescanAutomaticAffirmations('polymesh_private_dev', 1000000)).toBe(false);
  });
});
