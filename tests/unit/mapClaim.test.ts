/**
 * Regression tests for defect A12: `Claim`'s id omitted `issuer`, so two trusted issuers
 * attesting the same target/type/scope collided on one row. Depending on write order this
 * either silently lost one issuer's claim (`handleClaimAdded` overwrite) or silently revoked
 * it (`handleClaimRevoked` mutating the shared row) — both invisible to the SDK's
 * `issuerId: { in: $trustedClaimIssuers }` / `revokeDate: { isNull: true }` filters.
 *
 * `serializeLikeHarvester` is mocked to the identity function so event params can be passed
 * as plain decoded objects instead of real polkadot `Codec`s — this file is only concerned
 * with the id/store logic in mapClaim.ts, not with harvester-style serialization.
 */

import { SubstrateEvent } from '@subql/types';

jest.mock('../../src/mappings/serializeLikeHarvester', () => ({
  serializeLikeHarvester: (item: unknown) => item,
}));

import {
  getId,
  handleClaimAdded,
  handleClaimRevoked,
} from '../../src/mappings/entities/identities/mapClaim';

const TARGET = TEST_DID;
const ISSUER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ISSUER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const storeGet = (): jest.Mock => (globalThis as any).store.get as jest.Mock;
const storeSet = (): jest.Mock => (globalThis as any).store.set as jest.Mock;

/** A minimal Codec-like stand-in — only `.toString()` is exercised by the code under test. */
const mockCodec = (value: string) => ({ toString: () => value });

/**
 * Builds a mock `ClaimAdded`/`ClaimRevoked` `SubstrateEvent` for a CustomerDueDiligence claim.
 * CDD claims carry no `scope`, which keeps this out of `processClaimScope`
 * (and its `getAssetIdWithTicker` chain) entirely — the id/store logic under test here
 * does not depend on scope handling.
 */
const mockClaimEvent = (
  method: 'ClaimAdded' | 'ClaimRevoked',
  { issuer, cddId, dateValue }: { issuer: string; cddId: string; dateValue: string }
): SubstrateEvent => {
  const data = [
    mockCodec(TARGET),
    {
      claim: { CustomerDueDiligence: cddId },
      claim_issuer: issuer,
      issuance_date: dateValue,
      last_update_date: dateValue,
    },
  ];

  return {
    idx: 3,
    block: {
      block: { header: { number: { toString: () => '1234' } } },
      timestamp: new Date('2026-01-01T00:00:00Z'),
      specVersion: 8000000,
    },
    event: {
      method,
      section: 'identity',
      data,
      meta: {
        fields: data.map(() => ({ typeName: { isSome: true, unwrap: () => mockCodec('Dummy') } })),
      },
    },
  } as unknown as SubstrateEvent;
};

describe('getId', () => {
  it('includes the issuer, producing distinct ids for two issuers over an otherwise identical claim', () => {
    const idA = getId(
      TARGET,
      ISSUER_A,
      'CustomerDueDiligence',
      undefined,
      undefined,
      'cdd-1',
      undefined
    );
    const idB = getId(
      TARGET,
      ISSUER_B,
      'CustomerDueDiligence',
      undefined,
      undefined,
      'cdd-1',
      undefined
    );

    expect(idA).not.toBe(idB);
    expect(idA).toBe(`${TARGET}/${ISSUER_A}/CustomerDueDiligence/cdd-1`);
    expect(idB).toBe(`${TARGET}/${ISSUER_B}/CustomerDueDiligence/cdd-1`);
  });

  it('produces the same id for the same target/issuer/type/scope', () => {
    const first = getId(
      TARGET,
      ISSUER_A,
      'CustomerDueDiligence',
      undefined,
      undefined,
      'cdd-1',
      undefined
    );
    const second = getId(
      TARGET,
      ISSUER_A,
      'CustomerDueDiligence',
      undefined,
      undefined,
      'cdd-1',
      undefined
    );

    expect(first).toBe(second);
  });
});

describe('handleClaimAdded / handleClaimRevoked', () => {
  let claims: Record<string, any>;

  beforeEach(() => {
    claims = {};

    storeGet().mockImplementation((entity: string, id: string) => {
      if (entity === 'Claim') {
        return Promise.resolve(claims[id] ? { ...claims[id] } : undefined);
      }
      if (entity === 'Identity') {
        // Short-circuit createIdentityIfNotExists — identity creation is not under test here.
        return Promise.resolve({ id });
      }
      return Promise.resolve(undefined);
    });

    storeSet().mockImplementation((entity: string, id: string, data: any) => {
      if (entity === 'Claim') {
        claims[id] = { ...data };
      }
      return Promise.resolve();
    });
  });

  it('gives two issuers attesting the same target/type/scope two distinct Claim rows', async () => {
    await handleClaimAdded(
      mockClaimEvent('ClaimAdded', { issuer: ISSUER_A, cddId: 'cdd-1', dateValue: '1000' })
    );
    await handleClaimAdded(
      mockClaimEvent('ClaimAdded', { issuer: ISSUER_B, cddId: 'cdd-1', dateValue: '2000' })
    );

    const ids = Object.keys(claims);
    expect(ids).toHaveLength(2);

    const idA = getId(
      TARGET,
      ISSUER_A,
      'CustomerDueDiligence',
      undefined,
      undefined,
      'cdd-1',
      undefined
    );
    const idB = getId(
      TARGET,
      ISSUER_B,
      'CustomerDueDiligence',
      undefined,
      undefined,
      'cdd-1',
      undefined
    );

    expect(claims[idA]).toMatchObject({ issuerId: ISSUER_A, targetId: TARGET });
    expect(claims[idB]).toMatchObject({ issuerId: ISSUER_B, targetId: TARGET });
  });

  it('leaves issuer A untouched and unrevoked when issuer B revokes its own claim', async () => {
    await handleClaimAdded(
      mockClaimEvent('ClaimAdded', { issuer: ISSUER_A, cddId: 'cdd-1', dateValue: '1000' })
    );
    await handleClaimAdded(
      mockClaimEvent('ClaimAdded', { issuer: ISSUER_B, cddId: 'cdd-1', dateValue: '2000' })
    );

    await handleClaimRevoked(
      mockClaimEvent('ClaimRevoked', { issuer: ISSUER_B, cddId: 'cdd-1', dateValue: '3000' })
    );

    const idA = getId(
      TARGET,
      ISSUER_A,
      'CustomerDueDiligence',
      undefined,
      undefined,
      'cdd-1',
      undefined
    );
    const idB = getId(
      TARGET,
      ISSUER_B,
      'CustomerDueDiligence',
      undefined,
      undefined,
      'cdd-1',
      undefined
    );

    expect(claims[idA].revokeDate).toBeUndefined();
    expect(claims[idB].revokeDate).toBe('3000');
  });

  it('clears revokeDate when the same issuer re-issues the claim after revoking it', async () => {
    await handleClaimAdded(
      mockClaimEvent('ClaimAdded', { issuer: ISSUER_A, cddId: 'cdd-1', dateValue: '1000' })
    );

    await handleClaimRevoked(
      mockClaimEvent('ClaimRevoked', { issuer: ISSUER_A, cddId: 'cdd-1', dateValue: '2000' })
    );

    const id = getId(
      TARGET,
      ISSUER_A,
      'CustomerDueDiligence',
      undefined,
      undefined,
      'cdd-1',
      undefined
    );
    expect(claims[id].revokeDate).toBe('2000');

    await handleClaimAdded(
      mockClaimEvent('ClaimAdded', { issuer: ISSUER_A, cddId: 'cdd-1', dateValue: '3000' })
    );

    expect(claims[id].revokeDate).toBeUndefined();
  });

  it('logs an error instead of silently returning when a revocation matches no row', async () => {
    await handleClaimRevoked(
      mockClaimEvent('ClaimRevoked', { issuer: ISSUER_A, cddId: 'cdd-1', dateValue: '1000' })
    );

    expect((globalThis as any).logger.error).toHaveBeenCalledWith(
      expect.stringContaining(ISSUER_A)
    );
    expect(Object.keys(claims)).toHaveLength(0);
  });
});
