/**
 * `identity.AuthorizationRetryLimitReached` — the chain gives up re-offering an authorization
 * after too many failed accept attempts. Same `(Option<IdentityId>, Option<AccountId>, u64)`
 * shape as the other authorization-outcome events, so it rides the existing status handler and
 * marks the row `RetryLimitReached`.
 */

import { SubstrateEvent } from '@subql/types';
import { AccountKeyRole, Authorization, AuthorizationStatusEnum } from '../../src/types';
import { handleAuthorization } from '../../src/mappings/entities/identities/mapAuthorization';
import { offerSubsidy } from '../../src/mappings/entities/relayer/mapSubsidy';
import { codec as helperCodec, mockLedgerAccountQuery, mockStore, tupleEvent } from './helpers';

const DID = '0x01'.padEnd(66, '0');
const KEY = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const AUTH_ID = '42';

const codec = (value: string) => ({ toString: () => value, toJSON: () => value });

const retryLimitEvent = (): SubstrateEvent =>
  ({
    idx: 3,
    block: {
      block: { header: { number: { toString: () => '5000000' } } },
      timestamp: new Date('2024-01-01T00:00:00.000Z'),
      specVersion: 8_000_000,
    },
    event: {
      section: 'identity',
      method: 'AuthorizationRetryLimitReached',
      data: [codec(DID), codec(KEY), codec(AUTH_ID)],
      meta: {
        fields: [
          { name: { isSome: false } },
          { name: { isSome: false } },
          { name: { isSome: false } },
        ],
      },
    },
  } as unknown as SubstrateEvent);

beforeEach(() => {
  (api.runtimeVersion.specName as any).toString = () => 'polymesh';
});

describe('handleAuthorization — AuthorizationRetryLimitReached', () => {
  it('marks the authorization RetryLimitReached', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const row: any = { id: AUTH_ID, status: AuthorizationStatusEnum.Pending, save };
    const get = jest.spyOn(Authorization, 'get').mockResolvedValue(row);

    await handleAuthorization(retryLimitEvent());

    // looked up by the zero-padded id, not the raw chain sequence "42"
    expect(get).toHaveBeenCalledWith('0000000042');
    expect(row.status).toBe(AuthorizationStatusEnum.RetryLimitReached);
    expect(row.updatedEventId).toBe('0005000000/0000000003');
    expect(save).toHaveBeenCalled();
  });

  it('does nothing when the authorization row is absent (created before the index start)', async () => {
    jest.spyOn(Authorization, 'get').mockResolvedValue(undefined);

    await expect(handleAuthorization(retryLimitEvent())).resolves.toBeUndefined();
  });
});

describe('handleAuthorization — AuthorizationAdded', () => {
  const added = (
    targetDid: string | null,
    targetKey: string | null,
    authorizationData: unknown = { joinIdentity: { asset: null } }
  ) =>
    tupleEvent({
      section: 'identity',
      method: 'AuthorizationAdded',
      data: [
        helperCodec(DID),
        helperCodec(targetDid),
        helperCodec(targetKey),
        helperCodec(AUTH_ID),
        helperCodec(authorizationData),
        helperCodec(null),
      ],
    });

  /** the issuer's identity, over a chain holding no key record for the target key */
  const mockIssuer = () => {
    const db = mockStore({ Identity: { [DID]: { id: DID } } });
    (globalThis as any).api.query = mockLedgerAccountQuery();
    return db;
  };

  it("stores a key's permissions with its extrinsic permissions in the index's form", async () => {
    const db = mockIssuer();
    const permissions = {
      asset: { whole: null },
      // as v14 to 7.0 decode it: a list, camelCase fields, names in hex
      extrinsic: {
        these: [{ palletName: '0x4173736574', dispatchableNames: { these: ['0x6973737565'] } }],
      },
      portfolio: { whole: null },
    };

    await handleAuthorization(added(null, KEY, { joinIdentity: permissions }));

    expect(JSON.parse(db.Authorization['0000000042'].data)).toEqual({
      asset: { whole: null },
      extrinsic: { these: { Asset: { extrinsics: { these: ['issue'] } } } },
      portfolio: { whole: null },
    });
  });

  it('links an authorization to a key by the SS58 address its Account row is keyed by', async () => {
    const db = mockIssuer();

    await handleAuthorization(added(null, KEY));

    expect(db.Authorization['0000000042']).toMatchObject({ toAccountId: KEY, toId: undefined });
    expect(db.Authorization['0000000042'].toKey).toBeUndefined();
  });

  /** testnet: 101 authorization targets that never held a key or POLYX had no `Account` row */
  it('creates the Account of a target the chain holds no key record for', async () => {
    const db = mockIssuer();

    await handleAuthorization(added(null, KEY));

    expect(db.Account[KEY]).toMatchObject({
      id: KEY,
      address: KEY,
      keyRole: AccountKeyRole.Unlinked,
      createdEventId: '0000001000/0000000000',
    });
  });

  it('links an authorization to an identity', async () => {
    const TARGET = '0x02'.padEnd(66, '0');
    const db = mockStore({ Identity: { [DID]: { id: DID } } });

    await handleAuthorization(added(TARGET, null));

    expect(db.Authorization['0000000042']).toMatchObject({ toId: TARGET, toAccountId: undefined });
  });

  /**
   * A paying-key authorization raised through `identity.add_authorization` emits no relayer event,
   * and is addressed to the paying key, which accepts it (testnet authorization 51504).
   */
  it('records the subsidy a paying-key authorization offers', async () => {
    const USER = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
    const db = mockStore({
      Identity: { [DID]: { id: DID } },
      Account: { [USER]: { id: USER }, [KEY]: { id: KEY } },
    });
    const offered = tupleEvent({
      section: 'identity',
      method: 'AuthorizationAdded',
      data: [
        helperCodec(DID),
        helperCodec(null),
        helperCodec(KEY),
        helperCodec(AUTH_ID),
        helperCodec({ addRelayerPayingKey: [USER, KEY, 10_000_000] }),
        helperCodec(null),
      ],
    });

    await handleAuthorization(offered);

    expect(db.Subsidy[`${USER}/${KEY}`]).toMatchObject({
      beneficiaryAccountId: USER,
      payingAccountId: KEY,
      allowance: BigInt(10_000_000),
      isAccepted: false,
      isRemoved: false,
    });

    // `set_paying_key` raises the same offer as a relayer event too, which keeps the row it made
    await offerSubsidy(
      { userKey: USER, payingKey: KEY, limit: BigInt(20_000_000) },
      { block: offered.block, blockId: '0000001000', blockEventId: '0000001000/0000000001' }
    );
    expect(db.Subsidy[`${USER}/${KEY}`]).toMatchObject({
      allowance: BigInt(20_000_000),
      createdEventId: '0000001000/0000000000',
      updatedEventId: '0000001000/0000000001',
    });
  });
});
