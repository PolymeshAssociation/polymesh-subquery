/**
 * Regression tests: `Claim`'s id omitted `issuer`, so two trusted issuers
 * attesting the same target/type/scope collided on one row. Depending on write order this
 * either silently lost one issuer's claim (`handleClaimAdded` overwrite) or silently revoked
 * it (`handleClaimRevoked` mutating the shared row) — both invisible to the SDK's
 * `issuerId: { in: $trustedClaimIssuers }` / `revokeDate: { isNull: true }` filters.
 */

import { TypeRegistry } from '@polkadot/types';
import { typesBundle } from '@polymeshassociation/polymesh-types';
import { SubstrateEvent } from '@subql/types';
import {
  getId,
  handleClaimAdded,
  handleClaimRevoked,
  seedGenesisClaims,
} from '../../src/mappings/entities/identities/mapClaim';

const TARGET = TEST_DID;
const ISSUER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ISSUER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CDD_1 = `0x${'c1'.repeat(32)}`;
const CDD_GENESIS = `0x${'c0'.repeat(32)}`;

/** The chain types of the latest runtime, so claims are real `IdentityClaim` codecs. */
const registry = new TypeRegistry();
registry.setKnownTypes({ typesBundle: typesBundle as never });
registry.register(
  ((typesBundle as any).spec.polymesh_mainnet.types as { minmax: number[]; types: never }[]).find(
    ({ minmax }) => minmax[0] === 8_000_000
  )?.types as never
);

const identityClaim = (issuer: string, cddId: string, date: string) =>
  registry.createType('IdentityClaim', {
    claimIssuer: issuer,
    issuanceDate: date,
    lastUpdateDate: date,
    expiry: null,
    claim: { CustomerDueDiligence: cddId },
  });

const storeGet = (): jest.Mock => (globalThis as any).store.get as jest.Mock;
const storeSet = (): jest.Mock => (globalThis as any).store.set as jest.Mock;

/**
 * When a revocation happens: the block's timestamp, not the `issuanceDate` the `ClaimRevoked`
 * payload carries, which is the revoked claim's own.
 */
const REVOKED_AT = BigInt(new Date('2026-01-01T00:00:00Z').getTime());

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
  const data = [mockCodec(TARGET), identityClaim(issuer, cddId, dateValue)];

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
        // Polymesh declares its events as tuples, so metadata carries a type per field and
        // `name` is `None`. That is what sends the decode layer to the registered shape table
        fields: data.map(() => ({
          name: { isSome: false },
          typeName: { isSome: true, unwrap: () => mockCodec('Dummy') },
        })),
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

  /**
   * Mainnet block 20,842,777: PIP 149 revoked a CDD claim from the chain's genesis config, which no
   * `ClaimAdded` announced. The index had never written it, so the revocation found nothing.
   */
  it('seeds the genesis claims, so a later revocation finds them', async () => {
    const genesisClaim = identityClaim(ISSUER_A, CDD_GENESIS, '0');
    (globalThis as any).api.query = {
      identity: {
        claims: {
          entries: jest.fn().mockResolvedValue([
            // the genesis runtime (v3.0) stores the claim itself, not an `Option` of it
            [{ args: [{ target: mockCodec(TARGET) }, {}] }, genesisClaim],
            // a later runtime's empty `Option` is no claim
            [
              { args: [{ target: mockCodec(ISSUER_B) }, {}] },
              { isNone: true, unwrap: () => genesisClaim },
            ],
          ]),
        },
      },
    };
    const genesis = {
      block: { header: { number: { toString: () => '0' } } },
      timestamp: new Date('2020-01-01T00:00:00Z'),
      specVersion: 3000,
    };

    await seedGenesisClaims(genesis as never, '0000000000', '0000000000/0000000000');

    const id = `${TARGET}/${ISSUER_A}/CustomerDueDiligence/${CDD_GENESIS}`;
    expect(Object.keys(claims)).toEqual([id]);
    expect(claims[id]).toMatchObject({
      targetId: TARGET,
      issuerId: ISSUER_A,
      issuanceDate: '0',
      createdEventId: '0000000000/0000000000',
    });

    await handleClaimRevoked(
      mockClaimEvent('ClaimRevoked', { issuer: ISSUER_A, cddId: CDD_GENESIS, dateValue: '5000' })
    );

    expect(claims[id].revokeDate).toBe(REVOKED_AT);
    (globalThis as any).api.query = {};
  });

  it('gives two issuers attesting the same target/type/scope two distinct Claim rows', async () => {
    await handleClaimAdded(
      mockClaimEvent('ClaimAdded', { issuer: ISSUER_A, cddId: CDD_1, dateValue: '1000' })
    );
    await handleClaimAdded(
      mockClaimEvent('ClaimAdded', { issuer: ISSUER_B, cddId: CDD_1, dateValue: '2000' })
    );

    const ids = Object.keys(claims);
    expect(ids).toHaveLength(2);

    const idA = getId(
      TARGET,
      ISSUER_A,
      'CustomerDueDiligence',
      undefined,
      undefined,
      CDD_1,
      undefined
    );
    const idB = getId(
      TARGET,
      ISSUER_B,
      'CustomerDueDiligence',
      undefined,
      undefined,
      CDD_1,
      undefined
    );

    expect(claims[idA]).toMatchObject({ issuerId: ISSUER_A, targetId: TARGET });
    expect(claims[idB]).toMatchObject({ issuerId: ISSUER_B, targetId: TARGET });
  });

  it('leaves issuer A untouched and unrevoked when issuer B revokes its own claim', async () => {
    await handleClaimAdded(
      mockClaimEvent('ClaimAdded', { issuer: ISSUER_A, cddId: CDD_1, dateValue: '1000' })
    );
    await handleClaimAdded(
      mockClaimEvent('ClaimAdded', { issuer: ISSUER_B, cddId: CDD_1, dateValue: '2000' })
    );

    await handleClaimRevoked(
      mockClaimEvent('ClaimRevoked', { issuer: ISSUER_B, cddId: CDD_1, dateValue: '3000' })
    );

    const idA = getId(
      TARGET,
      ISSUER_A,
      'CustomerDueDiligence',
      undefined,
      undefined,
      CDD_1,
      undefined
    );
    const idB = getId(
      TARGET,
      ISSUER_B,
      'CustomerDueDiligence',
      undefined,
      undefined,
      CDD_1,
      undefined
    );

    expect(claims[idA].revokeDate).toBeUndefined();
    expect(claims[idB].revokeDate).toBe(REVOKED_AT);
  });

  it('clears revokeDate when the same issuer re-issues the claim after revoking it', async () => {
    await handleClaimAdded(
      mockClaimEvent('ClaimAdded', { issuer: ISSUER_A, cddId: CDD_1, dateValue: '1000' })
    );

    await handleClaimRevoked(
      mockClaimEvent('ClaimRevoked', { issuer: ISSUER_A, cddId: CDD_1, dateValue: '2000' })
    );

    const id = getId(
      TARGET,
      ISSUER_A,
      'CustomerDueDiligence',
      undefined,
      undefined,
      CDD_1,
      undefined
    );
    expect(claims[id].revokeDate).toBe(REVOKED_AT);

    await handleClaimAdded(
      mockClaimEvent('ClaimAdded', { issuer: ISSUER_A, cddId: CDD_1, dateValue: '3000' })
    );

    expect(claims[id].revokeDate).toBeUndefined();
  });

  it('records an anomaly instead of silently returning when a revocation matches no row', async () => {
    await handleClaimRevoked(
      mockClaimEvent('ClaimRevoked', { issuer: ISSUER_A, cddId: CDD_1, dateValue: '1000' })
    );

    const anomalies = storeSet()
      .mock.calls.filter(([entity]) => entity === 'IndexerAnomaly')
      .map(([, , row]) => row);

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ kind: 'MissingReferencedEntity' });
    expect(anomalies[0].detail).toContain(ISSUER_A);
    expect(Object.keys(claims)).toHaveLength(0);
  });

  it('silently skips a stripped ClaimRevoked with a zero issuer (no anomaly)', async () => {
    await handleClaimRevoked(
      mockClaimEvent('ClaimRevoked', {
        issuer: '0x0000000000000000000000000000000000000000000000000000000000000000',
        cddId: CDD_1,
        dateValue: '0',
      })
    );

    const anomalies = storeSet()
      .mock.calls.filter(([entity]) => entity === 'IndexerAnomaly')
      .map(([, , row]) => row);

    expect(anomalies).toHaveLength(0);
    expect(Object.keys(claims)).toHaveLength(0);
  });
});
