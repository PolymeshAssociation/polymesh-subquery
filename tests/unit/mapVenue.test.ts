import '@subql/types-core/dist/global';
import '@subql/types/dist/global';
import { extractVenueSigners } from '../../src/mappings/entities/settlements/mapVenue';

/**
 * Regression tests for the `VenueSignersUpdated` chain 8.0.0 shape change: the `signers` param
 * changed from a `Vec<AccountId>` (array-like, has `.map`) to a `BTreeSet<AccountId>` (a native
 * `Set`, which has no `.map` and previously crashed the indexer with `o.map is not a function`).
 */
describe('extractVenueSigners', () => {
  const mockSigner = (address: string) => ({ toString: () => address });

  it('extracts addresses from an array-like Vec (pre-8.x chain)', () => {
    const rawSigners = [mockSigner('addr1'), mockSigner('addr2')];

    expect(extractVenueSigners(rawSigners as any)).toStrictEqual(['addr1', 'addr2']);
  });

  it('extracts addresses from a Set-like BTreeSet (8.x chain)', () => {
    const rawSigners = new Set([mockSigner('addr1'), mockSigner('addr2')]);

    expect(extractVenueSigners(rawSigners as any)).toStrictEqual(['addr1', 'addr2']);
  });

  it('returns an empty array for an empty Set', () => {
    expect(extractVenueSigners(new Set() as any)).toStrictEqual([]);
  });

  it('returns an empty array for an empty Vec', () => {
    expect(extractVenueSigners([] as any)).toStrictEqual([]);
  });
});
