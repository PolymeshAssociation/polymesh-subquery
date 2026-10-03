/**
 * `MultiSig` is linked to its own `Account` row: a multisig is an account, so `createMultiSig`
 * creates the account first and points `MultiSig.account` at it, and `MultiSigAdmin` names its
 * `admin` identity by relation rather than a bare string.
 *
 * A signer key is an account too, so an `Account` signer gets a relation to its row and takes its
 * `keyRole` from the chain's key record — creating a multisig only *offers* the role. An
 * `Identity` signer, which only pre-7.x runtimes allowed, keeps `signerValue` as the canonical
 * value and a null `signerAccount`.
 */

import {
  AccountKeyRole,
  MultiSigAdminStatusEnum,
  MultiSigSignerStatusEnum,
  SignerTypeEnum,
} from '../../src/types';

const ledgerAccount = jest.fn();
const resolveKeyRole = jest.fn();
const resolveIdentity = jest.fn();
jest.mock('../../src/utils/accounts', () => ({
  ledgerAccount: (...args: unknown[]) => ledgerAccount(...args),
  resolveKeyRole: (...args: unknown[]) => resolveKeyRole(...args),
}));
jest.mock('../../src/mappings/entities/identities/mapIdentities', () => ({
  resolveIdentity: (...args: unknown[]) => resolveIdentity(...args),
}));

import {
  createMultiSig,
  createMultiSigAdmin,
  createMultiSigSigner,
} from '../../src/mappings/entities/multiSig/mapMultiSig';

const MULTISIG = '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z';
const SIGNER = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const CREATOR_DID = '0x01'.padEnd(66, '0');
const CREATOR_ACCOUNT = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const datetime = new Date('2024-01-01T00:00:00.000Z');

type Row = Record<string, any>;
let db: Record<string, Row>;

beforeEach(() => {
  db = {};
  resolveKeyRole.mockReset().mockResolvedValue(AccountKeyRole.MultiSigSigner);
  resolveIdentity.mockReset().mockImplementation((did: string) => Promise.resolve(did));
  ledgerAccount.mockReset().mockImplementation((address: string) => {
    const row: Row = {
      id: address,
      address,
      keyRole: AccountKeyRole.Unlinked,
      save: jest.fn().mockResolvedValue(undefined),
    };
    db[`Account:${address}`] = row;
    return Promise.resolve(row);
  });
  (store.set as jest.Mock).mockImplementation((entity: string, id: string, data: Row) => {
    db[`${entity}:${id}`] = { ...data };
    return Promise.resolve();
  });
});

describe('createMultiSig', () => {
  it('creates the Account row first and links MultiSig.account to it', async () => {
    await createMultiSig(
      MULTISIG,
      CREATOR_DID,
      CREATOR_ACCOUNT,
      2,
      '0000001',
      datetime,
      '0000001/0000000000'
    );

    expect(ledgerAccount).toHaveBeenCalledWith(MULTISIG, '0000001', datetime, '0000001/0000000000');
    expect(db[`Account:${MULTISIG}`]).toBeDefined();

    const multiSig = db[`MultiSig:${MULTISIG}`];
    expect(multiSig).toMatchObject({
      id: MULTISIG,
      accountId: MULTISIG, // joinable to the Account row
      creatorId: CREATOR_DID,
      creatorAccountId: CREATOR_ACCOUNT,
      signaturesRequired: 2,
    });
    expect(multiSig).not.toHaveProperty('address');
  });

  it('leaves creator null when it is not known (the genesis seed path)', async () => {
    await createMultiSig(
      MULTISIG,
      undefined,
      undefined,
      3,
      '0000000',
      datetime,
      '0000000/0000000000'
    );

    const multiSig = db[`MultiSig:${MULTISIG}`];
    expect(multiSig.creatorId).toBeUndefined();
    expect(multiSig.creatorAccountId).toBeUndefined();
    expect(multiSig.accountId).toBe(MULTISIG); // still linked to its account
  });
});

describe('createMultiSigSigner', () => {
  it('sets signerAccount and takes keyRole from the key record for an Account signer', async () => {
    await createMultiSigSigner(
      MULTISIG,
      SignerTypeEnum.Account,
      SIGNER,
      MultiSigSignerStatusEnum.Authorized,
      '0000002',
      datetime,
      '0000002/0000000000'
    );

    expect(ledgerAccount).toHaveBeenCalledWith(SIGNER, '0000002', datetime, '0000002/0000000000');
    expect(db[`Account:${SIGNER}`].keyRole).toBe(AccountKeyRole.MultiSigSigner);

    const signer = db[`MultiSigSigner:${MULTISIG}/${SignerTypeEnum.Account}/${SIGNER}`];
    expect(signer.signerValue).toBe(SIGNER);
    expect(signer.signerAccountId).toBe(SIGNER);
  });

  /**
   * Creating a multisig and authorising a signer are offers — the chain writes the key record
   * only once the signer accepts. A key that is currently an identity's primary key must not be
   * relabelled by an offer it may never take up.
   */
  it('leaves a live primary key alone when the signer has not accepted', async () => {
    resolveKeyRole.mockResolvedValue(AccountKeyRole.PrimaryKey);

    await createMultiSigSigner(
      MULTISIG,
      SignerTypeEnum.Account,
      SIGNER,
      MultiSigSignerStatusEnum.Authorized,
      '0000002',
      datetime,
      '0000002/0000000000'
    );

    expect(db[`Account:${SIGNER}`].keyRole).toBe(AccountKeyRole.PrimaryKey);
  });

  it('leaves signerAccount null for an Identity signer (pre-7.x) and touches no account', async () => {
    await createMultiSigSigner(
      MULTISIG,
      SignerTypeEnum.Identity,
      CREATOR_DID,
      MultiSigSignerStatusEnum.Authorized,
      '0000002',
      datetime,
      '0000002/0000000000'
    );

    expect(ledgerAccount).not.toHaveBeenCalled();

    const signer = db[`MultiSigSigner:${MULTISIG}/${SignerTypeEnum.Identity}/${CREATOR_DID}`];
    expect(signer.signerValue).toBe(CREATOR_DID);
    expect(signer.signerAccountId).toBeUndefined();
  });
});

const identityContext = {
  reason: 'a test',
  eventIdx: 0,
  blockEventId: '0000001/0000000000',
};

describe('createMultiSigAdmin', () => {
  it('names the admin identity by relation', async () => {
    await createMultiSigAdmin(
      MULTISIG,
      CREATOR_DID,
      '0000001',
      '0000001/0000000000',
      identityContext
    );

    const admin = db[`MultiSigAdmin:${MULTISIG}/${CREATOR_DID}`];
    expect(admin).toMatchObject({
      multisigId: MULTISIG,
      adminId: CREATOR_DID,
      status: MultiSigAdminStatusEnum.Authorized,
    });
    expect(admin).not.toHaveProperty('identityId');
  });

  /**
   * `admin` is a non-null relation, so a DID the index has never seen would make the field
   * unresolvable for anyone selecting it. No row beats a broken one.
   */
  it('writes no row when the admin DID resolves to nothing', async () => {
    resolveIdentity.mockResolvedValue(undefined);

    await createMultiSigAdmin(
      MULTISIG,
      CREATOR_DID,
      '0000001',
      '0000001/0000000000',
      identityContext
    );

    expect(db[`MultiSigAdmin:${MULTISIG}/${CREATOR_DID}`]).toBeUndefined();
  });
});
