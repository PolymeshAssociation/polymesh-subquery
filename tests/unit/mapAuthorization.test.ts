/**
 * `identity.AuthorizationRetryLimitReached` — the chain gives up re-offering an authorization
 * after too many failed accept attempts. Same `(Option<IdentityId>, Option<AccountId>, u64)`
 * shape as the other authorization-outcome events, so it rides the existing status handler and
 * marks the row `RetryLimitReached`.
 */

import { SubstrateEvent } from '@subql/types';
import { Authorization, AuthorizationStatusEnum } from '../../src/types';
import { handleAuthorization } from '../../src/mappings/entities/identities/mapAuthorization';

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

    // looked up by the zero-padded id (D12), not the raw chain sequence "42"
    expect(get).toHaveBeenCalledWith('0000000042');
    expect(row.status).toBe(AuthorizationStatusEnum.RetryLimitReached);
    expect(row.updatedBlockId).toBe('0005000000');
    expect(save).toHaveBeenCalled();
  });

  it('does nothing when the authorization row is absent (created before the index start)', async () => {
    jest.spyOn(Authorization, 'get').mockResolvedValue(undefined);

    await expect(handleAuthorization(retryLimitEvent())).resolves.toBeUndefined();
  });
});
