/**
 * `Claim`'s id includes the issuer, so two trusted issuers attesting the same target, type and
 * scope are separate rows: neither overwrites nor revokes the other's claim.
 */

import { TypeRegistry } from '@polkadot/types';
import { typesBundle } from '@polymeshassociation/polymesh-types';
import { SubstrateEvent } from '@subql/types';
import * as encoding from '../../src/mappings/args/encode';
import {
  getId,
  handleClaimAdded,
  handleClaimRevoked,
} from '../../src/mappings/entities/identities/mapClaim';

const TARGET = TEST_DID;
const ISSUER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ISSUER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CDD_1 = `0x${'c1'.repeat(32)}`;

/** The chain types of the latest runtime, so claims are real `IdentityClaim` codecs. */
const registry = new TypeRegistry();
registry.setKnownTypes({ typesBundle: typesBundle as never });
registry.register(
  ((typesBundle as any).spec.polymesh_mainnet.types as { minmax: number[]; types: never }[]).find(
    ({ minmax }) => minmax[0] === 8_000_000
  )?.types as never
);

/** The chain types of v5, which still had the claim types the v6.0 upgrade removed. */
const v5 = new TypeRegistry();
v5.setKnownTypes({ typesBundle: typesBundle as never });
v5.register(
  ((typesBundle as any).spec.polymesh_mainnet.types as { minmax: number[]; types: never }[]).find(
    ({ minmax }) => minmax[0] === 5_004_000
  )?.types as never
);

const identityClaim = (issuer: string, cddId: string, date: string, expiry: number | null = null) =>
  registry.createType('IdentityClaim', {
    claimIssuer: issuer,
    issuanceDate: date,
    lastUpdateDate: date,
    expiry,
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
): SubstrateEvent => claimEvent(method, identityClaim(issuer, cddId, dateValue));

/** A `ClaimAdded`/`ClaimRevoked` event for `target` carrying `claim`, an `IdentityClaim` codec. */
const claimEvent = (
  method: 'ClaimAdded' | 'ClaimRevoked',
  claim: unknown,
  specVersion = 8000000
): SubstrateEvent => {
  const data = [mockCodec(TARGET), claim];

  return {
    idx: 3,
    block: {
      block: { header: { number: { toString: () => '1234' } } },
      timestamp: new Date('2026-01-01T00:00:00Z'),
      specVersion,
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
    const idA = getId(TARGET, ISSUER_A, 'CustomerDueDiligence', undefined, undefined);
    const idB = getId(TARGET, ISSUER_B, 'CustomerDueDiligence', undefined, undefined);

    expect(idA).not.toBe(idB);
    expect(idA).toBe(`${TARGET}/${ISSUER_A}/CustomerDueDiligence`);
    expect(idB).toBe(`${TARGET}/${ISSUER_B}/CustomerDueDiligence`);
  });

  it('produces the same id for the same target/issuer/type/scope', () => {
    const first = getId(TARGET, ISSUER_A, 'CustomerDueDiligence', undefined, undefined);
    const second = getId(TARGET, ISSUER_A, 'CustomerDueDiligence', undefined, undefined);

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
  it("stores the claim dates as bigints, not the encoding's decimal strings", async () => {
    await handleClaimAdded(
      mockClaimEvent('ClaimAdded', { issuer: ISSUER_A, cddId: CDD_1, dateValue: '1000' })
    );

    const [saved] = Object.values(claims);
    expect(typeof saved.issuanceDate).toBe('bigint');
    expect(typeof saved.lastUpdateDate).toBe('bigint');
    expect(saved.issuanceDate).toBe(BigInt(1000));
    expect(saved.expiry).toBeUndefined();
    expect(typeof saved.filterExpiry).toBe('bigint');
  });

  it.each(['issuanceDate', 'lastUpdateDate'])(
    'throws rather than store a claim whose %s the encoding lacks',
    async name => {
      const encoded = encoding.encodeValue(
        identityClaim(ISSUER_A, CDD_1, '1000'),
        'IdentityClaim'
      ) as Record<string, unknown>;
      const partial = { ...encoded };
      delete partial[name];
      const encode = jest
        .spyOn(encoding, 'encodeValue')
        .mockReturnValue(partial as unknown as ReturnType<typeof encoding.encodeValue>);

      try {
        await expect(
          handleClaimAdded(
            mockClaimEvent('ClaimAdded', { issuer: ISSUER_A, cddId: CDD_1, dateValue: '1000' })
          )
        ).rejects.toThrow(`IdentityClaim has no ${name}`);
        expect(Object.values(claims)).toHaveLength(0);
      } finally {
        encode.mockRestore();
      }
    }
  );

  it('keeps a zero expiry, rather than reading it as no expiry', async () => {
    await handleClaimAdded(claimEvent('ClaimAdded', identityClaim(ISSUER_A, CDD_1, '1000', 0)));

    const [saved] = Object.values(claims);
    expect(saved.expiry).toBe(BigInt(0));
    expect(saved.filterExpiry).toBe(BigInt(0));
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

    const idA = getId(TARGET, ISSUER_A, 'CustomerDueDiligence', undefined, undefined);
    const idB = getId(TARGET, ISSUER_B, 'CustomerDueDiligence', undefined, undefined);

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

    const idA = getId(TARGET, ISSUER_A, 'CustomerDueDiligence', undefined, undefined);
    const idB = getId(TARGET, ISSUER_B, 'CustomerDueDiligence', undefined, undefined);

    expect(claims[idA].revokeDate).toBeUndefined();
    expect(claims[idB].revokeDate).toBe(REVOKED_AT);
  });

  it('replaces a CDD claim its issuer re-issues with another CDD id, as the chain keys it', async () => {
    const CDD_2 = `0x${'c2'.repeat(32)}`;
    await handleClaimAdded(
      mockClaimEvent('ClaimAdded', { issuer: ISSUER_A, cddId: CDD_1, dateValue: '1000' })
    );
    await handleClaimAdded(
      mockClaimEvent('ClaimAdded', { issuer: ISSUER_A, cddId: CDD_2, dateValue: '2000' })
    );

    expect(Object.values(claims)).toEqual([expect.objectContaining({ cddId: CDD_2 })]);
  });

  it('replaces a jurisdiction claim its issuer re-issues for another country, as the chain keys it', async () => {
    const jurisdiction = (country: string) =>
      registry.createType('IdentityClaim', {
        claimIssuer: ISSUER_A,
        issuanceDate: 1,
        lastUpdateDate: 1,
        expiry: null,
        claim: { Jurisdiction: [country, { Identity: ISSUER_B }] },
      });
    await handleClaimAdded(claimEvent('ClaimAdded', jurisdiction('Ie')));
    await handleClaimAdded(claimEvent('ClaimAdded', jurisdiction('Fr')));

    expect(Object.values(claims)).toEqual([expect.objectContaining({ jurisdiction: 'FR' })]);
  });

  it('clears revokeDate when the same issuer re-issues the claim after revoking it', async () => {
    await handleClaimAdded(
      mockClaimEvent('ClaimAdded', { issuer: ISSUER_A, cddId: CDD_1, dateValue: '1000' })
    );

    await handleClaimRevoked(
      mockClaimEvent('ClaimRevoked', { issuer: ISSUER_A, cddId: CDD_1, dateValue: '2000' })
    );

    const id = getId(TARGET, ISSUER_A, 'CustomerDueDiligence', undefined, undefined);
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

  /**
   * From 7.0 the chain scopes a claim to an asset id, which a ticker can be unlinked from (testnet
   * MINT, block 20,687,589) or never have been an asset's (mainnet NIO).
   */
  it('scopes a claim to an asset by its id, as the chain does, not by its ticker', async () => {
    const ASSET_ID = `0x${'ab'.repeat(16)}`;
    const fallback = storeGet().getMockImplementation() as (entity: string, id: string) => unknown;
    storeGet().mockImplementation((entity: string, id: string) =>
      entity === 'Asset' ? Promise.resolve({ id, ticker: 'ACME' }) : fallback(entity, id)
    );
    const accredited = registry.createType('IdentityClaim', {
      claimIssuer: ISSUER_A,
      issuanceDate: 1,
      lastUpdateDate: 1,
      expiry: null,
      claim: { Accredited: { Asset: ASSET_ID } },
    });

    await handleClaimAdded(claimEvent('ClaimAdded', accredited));

    expect(Object.values(claims)).toEqual([
      expect.objectContaining({ scope: { type: 'Asset', value: ASSET_ID, assetId: ASSET_ID } }),
    ]);
  });

  it('scopes a claim before 7.0 by its ticker, as the chain did, beside the asset id', async () => {
    const accredited = v5.createType('IdentityClaim', {
      claim_issuer: ISSUER_A,
      issuance_date: 1,
      last_update_date: 1,
      expiry: null,
      claim: { Accredited: { Ticker: '0x414243000000000000000000' } },
    });

    await handleClaimAdded(claimEvent('ClaimAdded', accredited, 5004000));

    const [saved] = Object.values(claims);
    expect(saved.scope).toEqual({
      type: 'Asset',
      value: 'ABC',
      assetId: expect.stringMatching(/^0x[0-9a-f]{32}$/),
    });
  });

  /**
   * The v6.0 upgrade's storage migration deleted every `InvestorUniqueness`, `InvestorUniquenessV2`
   * and `NoData` claim without an event, so indexing them would leave them live forever.
   */
  it.each([
    [
      'InvestorUniqueness',
      { InvestorUniqueness: [{ Ticker: '0x414243000000000000000000' }, CDD_1, CDD_1] },
    ],
    ['InvestorUniquenessV2', { InvestorUniquenessV2: CDD_1 }],
    ['NoData', { NoData: null }],
  ])('does not index a %s claim, which the v6.0 upgrade removed from storage', async (_, claim) => {
    const stored = v5.createType('IdentityClaim', {
      claim_issuer: ISSUER_A,
      issuance_date: 1,
      last_update_date: 1,
      expiry: null,
      claim,
    });

    await handleClaimAdded(claimEvent('ClaimAdded', stored));
    await handleClaimRevoked(claimEvent('ClaimRevoked', stored));

    expect(storeSet().mock.calls.map(([entity]) => entity)).toEqual([]);
    expect(Object.keys(claims)).toHaveLength(0);
  });
});
