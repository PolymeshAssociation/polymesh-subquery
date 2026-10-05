import { SubstrateExtrinsic } from '@subql/types';

jest.mock('../../src/utils/storageAtParent', () => ({
  ...jest.requireActual('../../src/utils/storageAtParent'),
  storageAtParent: jest.fn(),
}));
import { storageAtParent, UndecodableStateError } from '../../src/utils/storageAtParent';
import { resolveFeePayer } from '../../src/mappings/entities/identities/feePayer';

const SIGNER = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const ISSUER_PRIMARY = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const MULTISIG = '5HWxMultisigAccountXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const CREATOR_PRIMARY = '5CFQCreatorPrimaryXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const ISSUER_DID = '0x' + '11'.repeat(32);
const MULTISIG_DID = '0x' + '22'.repeat(32);

/** Storage as the parent block holds it, keyed `section.item:keys`. */
let parentState: Record<string, unknown>;
const json = (value: unknown) => ({ toJSON: () => value, toString: () => String(value) });

let db: Record<string, Record<string, any>>;

const extrinsic = (section: string, method: string, args: Record<string, unknown>) =>
  ({
    idx: 1,
    block: {
      block: { header: { number: { toString: () => '1056451' }, parentHash: '0xparent' } },
      timestamp: new Date('2021-11-01T00:00:00.000Z'),
      specVersion: 3000,
    },
    extrinsic: {
      isSigned: true,
      signer: { toString: () => SIGNER },
      method: { section, method, toJSON: () => ({ args }) },
    },
  } as unknown as SubstrateExtrinsic);

beforeEach(() => {
  parentState = {};
  db = {};
  (storageAtParent as jest.Mock).mockImplementation(
    (_block: unknown, section: string, item: string, ...keys: unknown[]) => {
      const value = parentState[`${section}.${item}:${JSON.stringify(keys)}`];
      return Promise.resolve(value === undefined ? undefined : json(value));
    }
  );
  ((globalThis as any).store.get as jest.Mock).mockImplementation((entity: string, id: string) =>
    Promise.resolve(db[entity]?.[id])
  );
  ((globalThis as any).store.set as jest.Mock).mockImplementation(
    (entity: string, id: string, data: unknown) => {
      (db[entity] ??= {})[id] = data;
      return Promise.resolve();
    }
  );
});

const anomalies = () => Object.values(db['IndexerAnomaly'] ?? {});

/** An authorization addressed to the signer, issued by `ISSUER_DID`. */
const authFromIssuer = (authId: number) => {
  parentState[`identity.authorizations:${JSON.stringify([{ Account: SIGNER }, authId])}`] = {
    authorizedBy: ISSUER_DID,
  };
};

describe('resolveFeePayer', () => {
  it('charges an ordinary call to its signer, without reading any state', async () => {
    expect(await resolveFeePayer(extrinsic('balances', 'transfer', {}))).toBe(SIGNER);
    expect(storageAtParent).not.toHaveBeenCalled();
  });

  it.each([
    ['identity', 'joinIdentityAsKey', { auth_id: 7 }],
    ['identity', 'acceptPrimaryKey', { rotation_auth_id: 7, optional_cdd_auth_id: null }],
    ['identity', 'rotatePrimaryKeyToSecondary', { auth_id: 7, optional_cdd_auth_id: null }],
    ['multiSig', 'acceptMultisigSignerAsKey', { auth_id: 7 }],
    ['relayer', 'acceptPayingKey', { auth_id: 7 }],
    [
      'identity',
      'removeAuthorization',
      { target: { Account: SIGNER }, auth_id: 7, _auth_issuer_pays: true },
    ],
  ])(
    'charges %s.%s to the primary key of the authorization issuer',
    async (section, method, args) => {
      authFromIssuer(7);
      parentState[`identity.didRecords:${JSON.stringify([ISSUER_DID])}`] = {
        primaryKey: ISSUER_PRIMARY,
      };

      expect(await resolveFeePayer(extrinsic(section, method, args))).toBe(ISSUER_PRIMARY);
    }
  );

  it('reads camel-cased argument names as well as snake-cased ones', async () => {
    authFromIssuer(7);
    parentState[`identity.didRecords:${JSON.stringify([ISSUER_DID])}`] = {
      primaryKey: ISSUER_PRIMARY,
    };

    expect(await resolveFeePayer(extrinsic('identity', 'joinIdentityAsKey', { authId: 7 }))).toBe(
      ISSUER_PRIMARY
    );
  });

  it("charges remove_authorization to its signer when the issuer isn't paying", async () => {
    authFromIssuer(7);
    parentState[`identity.didRecords:${JSON.stringify([ISSUER_DID])}`] = {
      primaryKey: ISSUER_PRIMARY,
    };

    const call = extrinsic('identity', 'removeAuthorization', {
      target: { Account: SIGNER },
      auth_id: 7,
      _auth_issuer_pays: false,
    });

    expect(await resolveFeePayer(call)).toBe(SIGNER);
  });

  it('charges a wrapped call to the signer: only the outer call counts', async () => {
    authFromIssuer(7);

    const call = extrinsic('utility', 'batch', {
      calls: [{ section: 'identity', method: 'joinIdentityAsKey', args: { auth_id: 7 } }],
    });

    expect(await resolveFeePayer(call)).toBe(SIGNER);
  });

  it.each(['createOrApproveProposalAsKey', 'createProposalAsKey', 'approveAsKey', 'rejectAsKey'])(
    "charges multiSig.%s to the primary key of the multisig's identity",
    async method => {
      parentState[`multiSig.multiSigToIdentity:${JSON.stringify([MULTISIG])}`] = MULTISIG_DID;
      parentState[`identity.didRecords:${JSON.stringify([MULTISIG_DID])}`] = {
        primaryKey: CREATOR_PRIMARY,
      };

      expect(await resolveFeePayer(extrinsic('multiSig', method, { multisig: MULTISIG }))).toBe(
        CREATOR_PRIMARY
      );
    }
  );

  it("charges a multisig call to the multisig itself when it is its identity's primary key", async () => {
    parentState[`multiSig.multiSigToIdentity:${JSON.stringify([MULTISIG])}`] = MULTISIG_DID;
    parentState[`identity.didRecords:${JSON.stringify([MULTISIG_DID])}`] = { primaryKey: MULTISIG };

    expect(
      await resolveFeePayer(
        extrinsic('multiSig', 'createOrApproveProposalAsKey', { multisig: MULTISIG })
      )
    ).toBe(MULTISIG);
  });

  it.each(['proposeBridgeTx', 'batchProposeBridgeTx'])(
    "charges bridge.%s as a call on the bridge's controller multisig",
    async method => {
      parentState[`bridge.controller:${JSON.stringify([])}`] = MULTISIG;
      parentState[`multiSig.multiSigToIdentity:${JSON.stringify([MULTISIG])}`] = MULTISIG_DID;
      parentState[`identity.didRecords:${JSON.stringify([MULTISIG_DID])}`] = {
        primaryKey: CREATOR_PRIMARY,
      };

      expect(await resolveFeePayer(extrinsic('bridge', method, {}))).toBe(CREATOR_PRIMARY);
    }
  );

  it('reads a 5.x identity record, whose primary key is optional', async () => {
    authFromIssuer(7);
    // 5.x: `DidRecords` holds `Option<DidRecord { primary_key: Option<AccountId> }>`; decoded, the
    // same JSON shape, with `primaryKey` possibly null
    parentState[`identity.didRecords:${JSON.stringify([ISSUER_DID])}`] = {
      primaryKey: ISSUER_PRIMARY,
      secondaryKeys: [],
    };

    expect(await resolveFeePayer(extrinsic('identity', 'joinIdentityAsKey', { auth_id: 7 }))).toBe(
      ISSUER_PRIMARY
    );
  });

  it('reads the snake-cased field names a runtime before metadata v14 decodes to', async () => {
    // testnet block 466,634 (spec 3000): the authorization decodes as
    // `{ authorization_data, authorized_by, expiry, auth_id }`
    parentState[`identity.authorizations:${JSON.stringify([{ Account: SIGNER }, 7])}`] = {
      authorized_by: ISSUER_DID,
    };
    parentState[`identity.didRecords:${JSON.stringify([ISSUER_DID])}`] = {
      primary_key: ISSUER_PRIMARY,
    };

    expect(
      await resolveFeePayer(extrinsic('multiSig', 'acceptMultisigSignerAsKey', { auth_id: 7 }))
    ).toBe(ISSUER_PRIMARY);
  });

  it('falls back to the index for an authorization created earlier in the same block', async () => {
    // not in the parent's state: the index already holds it, from this block's earlier events
    db['Authorization'] = { '0000000007': { id: '0000000007', fromId: ISSUER_DID } };
    db['Identity'] = {
      [ISSUER_DID]: { id: ISSUER_DID, did: ISSUER_DID, primaryAccount: ISSUER_PRIMARY },
    };

    expect(await resolveFeePayer(extrinsic('identity', 'joinIdentityAsKey', { auth_id: 7 }))).toBe(
      ISSUER_PRIMARY
    );
  });

  it('falls back to the signer, and says so, when the state does not decode', async () => {
    (storageAtParent as jest.Mock).mockRejectedValue(
      new UndecodableStateError('could not decode identity.authorizations', new Error('bad input'))
    );

    expect(await resolveFeePayer(extrinsic('identity', 'joinIdentityAsKey', { auth_id: 7 }))).toBe(
      SIGNER
    );
    expect(anomalies()).toHaveLength(1);
    expect((anomalies()[0] as { detail: string }).detail).toContain('bad input');
  });

  it('fails the block when reading the state fails', async () => {
    (storageAtParent as jest.Mock).mockRejectedValue(new Error('WebSocket is not connected'));

    await expect(
      resolveFeePayer(extrinsic('identity', 'joinIdentityAsKey', { auth_id: 7 }))
    ).rejects.toThrow('WebSocket is not connected');
    expect(anomalies()).toHaveLength(0);
  });

  it('falls back to the signer, and says so, when the payer cannot be found', async () => {
    expect(await resolveFeePayer(extrinsic('identity', 'joinIdentityAsKey', { auth_id: 7 }))).toBe(
      SIGNER
    );
    expect(anomalies()).toHaveLength(1);
  });
});
