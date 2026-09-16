/**
 * `keyRole` is mutable state and rides the same writes that link/unlink a key: when
 * `SecondaryKeyLeftIdentity` (or `PrimaryKeyUpdated`) clears `Account.identityId`, it also sets
 * `keyRole` to `Unlinked` in the same save — a stale role field would be worse than none.
 */

import { SubstrateEvent } from '@subql/types';
import { Account, KeyRoleEnum } from '../../src/types';
import { handleSecondaryKeyLeftIdentity } from '../../src/mappings/entities/identities/mapIdentities';

const DID = '0x01'.padEnd(66, '0');
const SECONDARY = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

const codec = (value: string) => ({ toString: () => value, toJSON: () => value });

const leftIdentityEvent = (): SubstrateEvent =>
  ({
    idx: 2,
    block: {
      block: { header: { number: { toString: () => '900000' } } },
      timestamp: new Date('2024-01-01T00:00:00.000Z'),
      specVersion: 7_000_000,
    },
    event: {
      section: 'identity',
      method: 'SecondaryKeyLeftIdentity',
      data: [codec(DID), codec(SECONDARY)],
      meta: { fields: [{ name: { isSome: false } }, { name: { isSome: false } }] },
    },
  } as unknown as SubstrateEvent);

beforeEach(() => {
  (api.runtimeVersion.specName as any).toString = () => 'polymesh';
  (store.getByFields as jest.Mock).mockResolvedValue([]);
});

describe('handleSecondaryKeyLeftIdentity', () => {
  it('nulls identityId and sets keyRole = Unlinked in the same write', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const account: any = {
      id: SECONDARY,
      identityId: DID,
      keyRole: KeyRoleEnum.SecondaryKey,
      save,
    };
    jest.spyOn(Account, 'get').mockResolvedValue(account);

    await handleSecondaryKeyLeftIdentity(leftIdentityEvent());

    expect(account.identityId).toBeUndefined();
    expect(account.keyRole).toBe(KeyRoleEnum.Unlinked);
    expect(save).toHaveBeenCalled();
  });
});
