/**
 * A key can be offered a multisig's signer place more than once, and accepting, ending or being
 * removed under one offer leaves the others standing: mainnet's 2Eh7o… accepted authorization
 * 20,627, was removed at 17,615,982, and is invited still by 20,599.
 */
import { handleAuthorization } from '../../src/mappings/entities/identities/mapAuthorization';
import { handleMultiSigSignersRemoved } from '../../src/mappings/entities/multiSig/mapMultiSig';
import { resolveKeyRole } from '../../src/utils/accounts';
import { mockStore, namedEvent, tupleEvent } from './helpers';
import { sandboxDate } from './sandbox';

jest.mock('../../src/utils/accounts', () => ({
  ...jest.requireActual('../../src/utils/accounts'),
  resolveKeyRole: jest.fn(),
}));

const MULTISIG = '2FTmkfcG6qxGWZ3MY5L9ctNyeJ6rauRfMEtknKTjXz1yom4q';
const OTHER_MULTISIG = '2FbK8p8bxbiWgjNFNaRDuKJc8Svx54nvN1M7tmg5TmAp9ggY';
const SIGNER = '2Eh7oDDaUPBUpiuW8s3jmtNx7a67UZtj5XbBocXUJ7mvmEfd';
const DID = '0x01'.padEnd(66, '0');
const SIGNER_ID = `${MULTISIG}/Account/${SIGNER}`;

const offer = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  type: 'AddMultiSigSigner',
  fromId: DID,
  toAccountId: SIGNER,
  data: JSON.stringify(MULTISIG),
  status: 'Pending',
  ...fields,
});

const signer = (status: string) => ({
  id: SIGNER_ID,
  multisigId: MULTISIG,
  signerType: 'Account',
  signerValue: SIGNER,
  signerAccountId: SIGNER,
  status,
});

const removed = () =>
  handleMultiSigSignersRemoved(
    namedEvent({
      section: 'multiSig',
      method: 'MultiSigSignersRemoved',
      fields: { callerDid: DID, multisig: MULTISIG, signers: [SIGNER] },
      blockNumber: '17615982',
    })
  );

beforeEach(() => {
  (resolveKeyRole as jest.Mock).mockReset().mockResolvedValue('Unlinked');
  (api.runtimeVersion.specName as any).toString = () => 'polymesh';
});

describe('a signer removed from its multisig', () => {
  it('is invited again while an offer of the place stands, and its key is no signer key', async () => {
    const db = mockStore({
      MultiSigSigner: { [SIGNER_ID]: signer('Approved') },
      Account: { [SIGNER]: { id: SIGNER, keyRole: 'MultiSigSigner' } },
      Authorization: {
        '0000020599': offer('0000020599'),
        '0000020627': offer('0000020627', { status: 'Consumed' }),
      },
    });

    await removed();

    expect(db.MultiSigSigner[SIGNER_ID]).toMatchObject({
      status: 'Authorized',
      updatedEventId: '0017615982/0000000000',
    });
    expect(db.Account[SIGNER].keyRole).toBe('Unlinked');
  });

  it('is removed when no offer stands: none pending, expired, or for another multisig', async () => {
    const db = mockStore({
      MultiSigSigner: { [SIGNER_ID]: signer('Approved') },
      Account: { [SIGNER]: { id: SIGNER, keyRole: 'MultiSigSigner' } },
      Authorization: {
        '0000000001': offer('0000000001', { status: 'Consumed' }),
        '0000000002': offer('0000000002', { expiry: new Date('2020-01-01T00:00:00Z') }),
        '0000000003': offer('0000000003', { data: JSON.stringify(OTHER_MULTISIG) }),
      },
    });

    await removed();

    expect(db.MultiSigSigner[SIGNER_ID].status).toBe('Removed');
  });

  it('is invited again under an offer expiring within the second after the block', async () => {
    const db = mockStore({
      MultiSigSigner: { [SIGNER_ID]: signer('Approved') },
      Account: { [SIGNER]: { id: SIGNER, keyRole: 'MultiSigSigner' } },
      Authorization: {
        '0000000001': offer('0000000001', {
          expiry: sandboxDate(Date.parse('2026-01-01T00:00:00.500Z')),
        }),
      },
    });

    await removed();

    expect(db.MultiSigSigner[SIGNER_ID].status).toBe('Authorized');
  });
});

it('keeps a signer invited when one of its offers ends unaccepted and another stands', async () => {
  const db = mockStore({
    MultiSigSigner: { [SIGNER_ID]: signer('Authorized') },
    Authorization: {
      '0000020599': offer('0000020599'),
      '0000020627': offer('0000020627'),
    },
  });

  await handleAuthorization(
    tupleEvent({
      section: 'identity',
      method: 'AuthorizationRejected',
      data: [{ toString: () => DID }, { toString: () => SIGNER }, { toString: () => '20627' }],
    })
  );

  expect(db.Authorization['0000020627'].status).toBe('Rejected');
  expect(db.MultiSigSigner[SIGNER_ID].status).toBe('Authorized');
});
