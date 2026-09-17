import {
  handlePermissionedIdentityAdded,
  handlePermissionedIdentityRemoved,
  handleValidatorPrefsSet,
} from '../../src/mappings/entities/events/mapValidator';
import {
  codec,
  mockGetByFields,
  mockLedgerAccountQuery,
  mockStore,
  namedEvent,
  tupleEvent,
} from './helpers';

const STASH = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

describe('handleValidatorPrefsSet', () => {
  it('upserts commission/blocked idempotently', async () => {
    const db = mockStore();
    (globalThis as any).api.query = { ...mockLedgerAccountQuery() };

    await handleValidatorPrefsSet(
      namedEvent({
        section: 'staking',
        method: 'ValidatorPrefsSet',
        fields: { stash: STASH, prefs: { commission: 50_000, blocked: false } },
      })
    );

    expect(db.Validator[STASH]).toMatchObject({
      accountId: STASH,
      commission: BigInt(50_000),
      blocked: false,
    });

    await handleValidatorPrefsSet(
      namedEvent({
        section: 'staking',
        method: 'ValidatorPrefsSet',
        fields: { stash: STASH, prefs: { commission: 75_000, blocked: true } },
        idx: 1,
      })
    );

    expect(Object.keys(db.Validator)).toHaveLength(1);
    expect(db.Validator[STASH]).toMatchObject({ commission: BigInt(75_000), blocked: true });
  });

  it('decodes a pre-v8 tuple ValidatorPrefsSet event the same way', async () => {
    const db = mockStore();
    (globalThis as any).api.query = { ...mockLedgerAccountQuery() };

    await handleValidatorPrefsSet(
      tupleEvent({
        section: 'staking',
        method: 'ValidatorPrefsSet',
        data: [codec(STASH), codec({ commission: 10_000, blocked: false })],
        specVersion: 7_004_001,
      })
    );

    expect(db.Validator[STASH]).toMatchObject({ commission: BigInt(10_000), blocked: false });
  });
});

describe('handlePermissionedIdentityAdded / handlePermissionedIdentityRemoved', () => {
  it('round-trips isPermissioned on an existing Validator row for that identity', async () => {
    const db = mockStore();
    mockGetByFields(db, 'Validator');
    (globalThis as any).api.query = { ...mockLedgerAccountQuery() };

    await handleValidatorPrefsSet(
      namedEvent({
        section: 'staking',
        method: 'ValidatorPrefsSet',
        fields: { stash: STASH, prefs: { commission: 0, blocked: false } },
      })
    );
    db.Validator[STASH].identityId = TEST_DID;

    await handlePermissionedIdentityAdded(
      namedEvent({
        section: 'validators',
        method: 'PermissionedIdentityAdded',
        fields: { governanceCouncillDid: TEST_DID, validatorsIdentity: TEST_DID },
        idx: 1,
      })
    );

    expect(db.Validator[STASH].isPermissioned).toBe(true);

    await handlePermissionedIdentityRemoved(
      namedEvent({
        section: 'validators',
        method: 'PermissionedIdentityRemoved',
        fields: { governanceCouncillDid: TEST_DID, validatorsIdentity: TEST_DID },
        idx: 2,
      })
    );

    expect(db.Validator[STASH].isPermissioned).toBe(false);
  });

  it('is a no-op when no Validator row exists yet for the permissioned identity', async () => {
    const db = mockStore();
    mockGetByFields(db, 'Validator');

    await expect(
      handlePermissionedIdentityAdded(
        namedEvent({
          section: 'validators',
          method: 'PermissionedIdentityAdded',
          fields: { governanceCouncillDid: TEST_DID, validatorsIdentity: TEST_DID },
        })
      )
    ).resolves.not.toThrow();

    expect(Object.keys(db.Validator ?? {})).toHaveLength(0);
  });
});

/**
 * `PermissionedIdentityAdded` usually fires *before* any `Validator` row exists for that identity —
 * rows are created later, by `StakersElected` — so `setPermissioned` found nothing to update and
 * the flag was silently lost. A testnet genesis resync saw 12 such events and ended with all 9,054
 * validators `isPermissioned: false`. The row now reads the flag from chain when it is created.
 */
describe('a Validator created after its identity was permissioned', () => {
  const DID = '0x0100000000000000000000000000000000000000000000000000000000000000';

  const prefsSet = () =>
    namedEvent({
      section: 'staking',
      method: 'ValidatorPrefsSet',
      fields: { stash: STASH, prefs: { commission: 0, blocked: false } },
    });

  const permissionedIn = (pallet: 'validators' | 'staking', prefs: unknown) => {
    (globalThis as any).api.query = {
      ...mockLedgerAccountQuery(),
      [pallet]: { permissionedIdentity: jest.fn().mockResolvedValue({ toJSON: () => prefs }) },
    };
  };

  it('picks up the flag from the v8 validators pallet', async () => {
    const db = mockStore({ Account: { [STASH]: { id: STASH, identityId: DID } } });
    permissionedIn('validators', { intendedCount: 2, runningCount: 0 });

    await handleValidatorPrefsSet(prefsSet());

    expect(db.Validator[STASH].isPermissioned).toBe(true);
  });

  it('picks up the flag from the pre-v8 staking pallet', async () => {
    const db = mockStore({ Account: { [STASH]: { id: STASH, identityId: DID } } });
    permissionedIn('staking', { intendedCount: 2, runningCount: 0 });

    await handleValidatorPrefsSet(prefsSet());

    expect(db.Validator[STASH].isPermissioned).toBe(true);
  });

  it('leaves it false when the identity is not permissioned', async () => {
    const db = mockStore({ Account: { [STASH]: { id: STASH, identityId: DID } } });
    permissionedIn('validators', null);

    await handleValidatorPrefsSet(prefsSet());

    expect(db.Validator[STASH].isPermissioned).toBe(false);
  });

  it('leaves it false when the chain cannot be read', async () => {
    const db = mockStore({ Account: { [STASH]: { id: STASH, identityId: DID } } });
    (globalThis as any).api.query = { ...mockLedgerAccountQuery() };

    await handleValidatorPrefsSet(prefsSet());

    expect(db.Validator[STASH].isPermissioned).toBe(false);
  });
});
