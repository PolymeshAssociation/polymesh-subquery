/**
 * `MultiSig` is linked to its own `Account` row (defect G5): a multisig is an account, so
 * `createMultiSig` creates the account first and points `MultiSig.account` at it, and
 * `MultiSigAdmin` names its `admin` identity by relation rather than a bare string.
 */

import { MultiSigAdminStatusEnum } from '../../src/types';

const ledgerAccount = jest.fn();
jest.mock('../../src/utils/accounts', () => ({
  ledgerAccount: (...args: unknown[]) => ledgerAccount(...args),
}));

import {
  createMultiSig,
  createMultiSigAdmin,
} from '../../src/mappings/entities/multiSig/mapMultiSig';

const MULTISIG = '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z';
const CREATOR_DID = '0x01'.padEnd(66, '0');
const CREATOR_ACCOUNT = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const datetime = new Date('2024-01-01T00:00:00.000Z');

type Row = Record<string, any>;
let db: Record<string, Row>;

beforeEach(() => {
  db = {};
  ledgerAccount.mockReset().mockImplementation((address: string) => {
    db[`Account:${address}`] = { id: address, address };
    return Promise.resolve(db[`Account:${address}`]);
  });
  (store.set as jest.Mock).mockImplementation((entity: string, id: string, data: Row) => {
    db[`${entity}:${id}`] = { ...data };
    return Promise.resolve();
  });
});

describe('createMultiSig', () => {
  it('creates the Account row first and links MultiSig.account to it', async () => {
    await createMultiSig(MULTISIG, CREATOR_DID, CREATOR_ACCOUNT, 2, '0000001', datetime);

    expect(ledgerAccount).toHaveBeenCalledWith(MULTISIG, '0000001', datetime);
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
});

describe('createMultiSigAdmin', () => {
  it('names the admin identity by relation', async () => {
    await createMultiSigAdmin(MULTISIG, CREATOR_DID, '0000001');

    const admin = db[`MultiSigAdmin:${MULTISIG}/${CREATOR_DID}`];
    expect(admin).toMatchObject({
      multisigId: MULTISIG,
      adminId: CREATOR_DID,
      status: MultiSigAdminStatusEnum.Authorized,
    });
    expect(admin).not.toHaveProperty('identityId');
  });
});
