/**
 * `keyRole` is mutable state and rides the same writes that link/unlink a key: when
 * `SecondaryKeyLeftIdentity` (or `PrimaryKeyUpdated`) clears `Account.identityId`, it also sets
 * `keyRole` to `Unlinked` in the same save — a stale role field would be worse than none.
 */

import { SubstrateEvent } from '@subql/types';
import { Account, Identity, IndexerAnomaly, AccountKeyRole } from '../../src/types';
import {
  handlePrimaryKeyUpdated,
  handleSecondaryKeyLeftIdentity,
  handleSecondaryKeysRemoved,
} from '../../src/mappings/entities/identities/mapIdentities';

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

const removedEvent = (): SubstrateEvent =>
  ({
    idx: 3,
    block: {
      block: { header: { number: { toString: () => '900001' } } },
      timestamp: new Date('2024-01-01T00:00:00.000Z'),
      specVersion: 7_000_000,
    },
    event: {
      section: 'identity',
      method: 'SecondaryKeysRemoved',
      data: [codec(DID), { toJSON: () => [SECONDARY], toString: () => `["${SECONDARY}"]` }],
      meta: { fields: [{ name: { isSome: false } }, { name: { isSome: false } }] },
    },
  } as unknown as SubstrateEvent);

const primaryKeyUpdatedEvent = (): SubstrateEvent =>
  ({
    idx: 4,
    block: {
      block: { header: { number: { toString: () => '900002' } } },
      timestamp: new Date('2024-01-01T00:00:00.000Z'),
      specVersion: 7_000_000,
    },
    event: {
      section: 'identity',
      method: 'PrimaryKeyUpdated',
      data: [codec(DID), codec(''), codec(SECONDARY)],
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
  (globalThis as any).api.registry = { chainSS58: 12 };
  (store.getByFields as jest.Mock).mockResolvedValue([]);
});

describe('handleSecondaryKeyLeftIdentity', () => {
  it('nulls identityId and sets keyRole = Unlinked in the same write', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const account: any = {
      id: SECONDARY,
      identityId: DID,
      keyRole: AccountKeyRole.SecondaryKey,
      save,
    };
    jest.spyOn(Account, 'get').mockResolvedValue(account);

    await handleSecondaryKeyLeftIdentity(leftIdentityEvent());

    expect(account.identityId).toBeUndefined();
    expect(account.keyRole).toBe(AccountKeyRole.Unlinked);
    expect(save).toHaveBeenCalled();
  });
});

describe('handleSecondaryKeysRemoved', () => {
  it('keeps the account row and unlinks it instead of deleting it', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const account: any = {
      id: SECONDARY,
      identityId: DID,
      keyRole: AccountKeyRole.SecondaryKey,
      save,
    };
    jest.spyOn(Account, 'get').mockResolvedValue(account);
    const remove = jest.spyOn(Account, 'remove').mockResolvedValue(undefined);

    await handleSecondaryKeysRemoved(removedEvent());

    expect(remove).not.toHaveBeenCalled();
    expect(account.identityId).toBeUndefined();
    expect(account.keyRole).toBe(AccountKeyRole.Unlinked);
    expect(save).toHaveBeenCalled();
  });

  it('records an anomaly when the removed key was never indexed', async () => {
    jest.spyOn(Account, 'get').mockResolvedValue(undefined);
    const anomaly = jest.spyOn(IndexerAnomaly.prototype, 'save').mockResolvedValue(undefined);

    await handleSecondaryKeysRemoved(removedEvent());

    expect(anomaly).toHaveBeenCalled();
  });
});

describe('handlePrimaryKeyUpdated', () => {
  /**
   * An identity created from a key record alone carries no primary key, so the outgoing account
   * cannot be read. The rotation still has to link the incoming key rather than kill the block.
   */
  it('links the new key and records an anomaly when the outgoing account is missing', async () => {
    const identitySave = jest.fn().mockResolvedValue(undefined);
    const identity: any = { id: DID, primaryAccount: '', save: identitySave };
    jest.spyOn(Identity, 'get').mockResolvedValue(identity);
    jest.spyOn(Account, 'get').mockResolvedValue(undefined);
    const anomaly = jest.spyOn(IndexerAnomaly.prototype, 'save').mockResolvedValue(undefined);
    const created = jest.spyOn(Account.prototype, 'save').mockResolvedValue(undefined);

    await handlePrimaryKeyUpdated(primaryKeyUpdatedEvent());

    expect(anomaly).toHaveBeenCalled();
    expect(identity.primaryAccount).toBe(SECONDARY);
    expect(identitySave).toHaveBeenCalled();
    expect(created).toHaveBeenCalled();
  });
});
