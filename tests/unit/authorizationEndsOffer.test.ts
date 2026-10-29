/**
 * An authorization that ends without being accepted (rejected, revoked, or given up on) ends the
 * offer it made: a multisig signer that never joined, a subsidy that never started.
 */
import { handleAuthorization } from '../../src/mappings/entities/identities/mapAuthorization';
import { codec, mockStore, tupleEvent } from './helpers';

const DID = `0x${'01'.repeat(32)}`;
const MS = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const KEY = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const PAYER = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy';
const AUTH = '0000000042';

/** `mockStore`, over a chain holding no other paying-key authorization */
const mockStoreAndChain: typeof mockStore = db => {
  const stored = mockStore(db);
  (globalThis as any).api.query = {
    relayer: {},
    identity: { authorizations: { entries: jest.fn().mockResolvedValue([]) } },
  };
  return stored;
};

const ended = (method: string) =>
  tupleEvent({ section: 'identity', method, data: [codec(null), codec(KEY), codec(42)] });

it.each(['AuthorizationRejected', 'AuthorizationRevoked', 'AuthorizationRetryLimitReached'])(
  '%s removes the multisig signer it offered',
  async method => {
    const signer = `${MS}/Account/${KEY}`;
    const db = mockStoreAndChain({
      Authorization: {
        [AUTH]: {
          id: AUTH,
          type: 'AddMultiSigSigner',
          toAccountId: KEY,
          data: JSON.stringify(MS),
          status: 'Pending',
        },
      },
      MultiSigSigner: { [signer]: { id: signer, status: 'Authorized' } },
    });

    await handleAuthorization(ended(method));

    expect(db.MultiSigSigner[signer]).toMatchObject({
      status: 'Removed',
      updatedEventId: '0000001000/0000000000',
    });
  }
);

it('removes the subsidy a paying-key authorization offered, and not one accepted', async () => {
  const offered = `${KEY}/${PAYER}`;
  const db = mockStoreAndChain({
    Authorization: {
      [AUTH]: {
        id: AUTH,
        type: 'AddRelayerPayingKey',
        toAccountId: KEY,
        data: JSON.stringify([KEY, PAYER, 100]),
        status: 'Pending',
      },
    },
    Subsidy: { [offered]: { id: offered, isAccepted: false, isRemoved: false } },
  });

  await handleAuthorization(ended('AuthorizationRejected'));

  expect(db.Subsidy[offered]).toMatchObject({ isRemoved: true });
});

it('leaves an accepted subsidy, which the chain goes on paying from', async () => {
  const accepted = `${KEY}/${PAYER}`;
  const db = mockStoreAndChain({
    Authorization: {
      [AUTH]: {
        id: AUTH,
        type: 'AddRelayerPayingKey',
        toAccountId: KEY,
        data: JSON.stringify([KEY, PAYER, 100]),
        status: 'Pending',
      },
    },
    Subsidy: { [accepted]: { id: accepted, isAccepted: true, isRemoved: false } },
  });

  await handleAuthorization(ended('AuthorizationRevoked'));

  expect(db.Subsidy[accepted]).toMatchObject({ isRemoved: false });
});

it('keeps the offer when another paying-key authorization from the same key is still pending', async () => {
  const offered = `${KEY}/${PAYER}`;
  const db = mockStoreAndChain({
    Authorization: {
      [AUTH]: {
        id: AUTH,
        type: 'AddRelayerPayingKey',
        toAccountId: KEY,
        data: JSON.stringify([KEY, PAYER, 100]),
        status: 'Pending',
      },
    },
    Subsidy: {
      [offered]: {
        id: offered,
        beneficiaryAccountId: KEY,
        payingAccountId: PAYER,
        allowance: BigInt(100),
        isAccepted: false,
        isRemoved: false,
      },
    },
  });
  (globalThis as any).api.query = {
    relayer: {},
    identity: {
      authorizations: {
        entries: jest
          .fn()
          .mockResolvedValue([
            [
              { args: [codec({ Account: KEY }), codec(41)] },
              codec({ authorizationData: { addRelayerPayingKey: [KEY, PAYER, 70] } }),
            ],
          ]),
      },
    },
  };

  await handleAuthorization(ended('AuthorizationRevoked'));

  expect(db.Subsidy[offered]).toMatchObject({
    isAccepted: false,
    isRemoved: false,
    allowance: BigInt(70),
  });
});
