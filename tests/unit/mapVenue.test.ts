import '@subql/types-core/dist/global';
import '@subql/types/dist/global';
import {
  extractVenueSigners,
  handleVenueCreated,
} from '../../src/mappings/entities/settlements/mapVenue';
import { codec, mockStore, tupleEvent } from './helpers';

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

/**
 * `createVenue` takes the venue's first signers and announces them with no `VenueSignersUpdated`,
 * so the new venue's signers are read from the chain.
 */
describe('a venue created with signers', () => {
  it('has the signers the chain holds for it', async () => {
    const db = mockStore();
    const keys = jest.fn(async () => [{ args: [codec(7), codec('5Signer')] }]);
    (globalThis as any).api.query = { settlement: { venueSigners: { keys } } };

    await handleVenueCreated(
      tupleEvent({
        section: 'settlement',
        method: 'VenueCreated',
        data: [codec(TEST_DID), codec(7), codec('0x'), codec('Other')],
      })
    );

    expect(db.Venue['0000000007']).toMatchObject({ signers: ['5Signer'] });
  });
});
