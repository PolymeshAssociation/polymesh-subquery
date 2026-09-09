import { Codec } from '@polkadot/types/types';
import { Account } from '../../src/types';
import { getOrCreateAccount } from '../../src/utils/accounts';
import {
  createIdentity,
  createPermissions,
} from '../../src/mappings/entities/identities/mapIdentities';

jest.mock('../../src/mappings/entities/identities/mapIdentities', () => ({
  createIdentity: jest.fn(),
  createPermissions: jest.fn(),
}));

const ADDRESS = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const OTHER = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

const keyRecords = () => (api.query as any).identity.keyRecords as jest.Mock;

const emptyRecord = { isEmpty: true } as unknown as Codec;

const MULTISIG = '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z';

/** A key record naming `MULTISIG` as the multisig this address signs for. */
const multiSigSignerRecord = {
  isEmpty: false,
  unwrap: () => ({
    isPrimaryKey: false,
    isSecondaryKey: false,
    asMultiSigSignerKey: { toString: () => MULTISIG },
  }),
} as unknown as Codec;

const datetime = new Date('2024-01-01T00:00:00.000Z');

/**
 * The cache is block scoped and this file shares one module instance, so each case works in its
 * own block rather than relying on a reset between them.
 */
let nextBlock = 100;
const freshBlockId = () => `${nextBlock++}`.padStart(10, '0');

describe('getOrCreateAccount block cache', () => {
  beforeEach(() => {
    (api as any).query = { identity: { keyRecords: jest.fn().mockResolvedValue(emptyRecord) } };
    jest.spyOn(Account, 'get').mockResolvedValue(undefined);
  });

  it('reads the chain once for an address it has already failed to resolve', async () => {
    const blockId = freshBlockId();

    await getOrCreateAccount(ADDRESS, blockId, datetime);
    await getOrCreateAccount(ADDRESS, blockId, datetime);
    await getOrCreateAccount(ADDRESS, blockId, datetime);

    expect(keyRecords()).toHaveBeenCalledTimes(1);
  });

  it('still returns undefined on a cached negative', async () => {
    const blockId = freshBlockId();

    await getOrCreateAccount(ADDRESS, blockId, datetime);

    await expect(getOrCreateAccount(ADDRESS, blockId, datetime)).resolves.toBeUndefined();
  });

  it('caches per address, so a second unknown address is still resolved', async () => {
    const blockId = freshBlockId();

    await getOrCreateAccount(ADDRESS, blockId, datetime);
    await getOrCreateAccount(OTHER, blockId, datetime);

    expect(keyRecords()).toHaveBeenCalledTimes(2);
  });

  it('re-reads the chain on the next block, so a key record added since is picked up', async () => {
    await getOrCreateAccount(ADDRESS, freshBlockId(), datetime);
    await getOrCreateAccount(ADDRESS, freshBlockId(), datetime);

    expect(keyRecords()).toHaveBeenCalledTimes(2);
  });

  it('serves a known account from the store without reading the chain', async () => {
    const existing = { id: ADDRESS, identityId: '0xdid' } as unknown as Account;
    (Account.get as jest.Mock).mockResolvedValue(existing);

    const blockId = freshBlockId();

    const first = await getOrCreateAccount(ADDRESS, blockId, datetime);
    const second = await getOrCreateAccount(ADDRESS, blockId, datetime);

    expect(first).toBe(existing);
    expect(second).toBe(existing);
    expect(keyRecords()).not.toHaveBeenCalled();
  });

  /**
   * The `Account` row can change partway through a block - a handler links or unlinks a key - so
   * only the chain read is cached. Caching the row shadowed writes made by the handlers that ran
   * between two lookups of the same address.
   */
  it('sees a row another handler wrote after a negative was already cached', async () => {
    const blockId = freshBlockId();

    await expect(getOrCreateAccount(ADDRESS, blockId, datetime)).resolves.toBeUndefined();

    const written = { id: ADDRESS, identityId: '0xdid' } as unknown as Account;
    (Account.get as jest.Mock).mockResolvedValue(written);

    await expect(getOrCreateAccount(ADDRESS, blockId, datetime)).resolves.toBe(written);
    // still only the one chain read: that answer cannot change within the block
    expect(keyRecords()).toHaveBeenCalledTimes(1);
  });

  it('sees an identity another handler unlinked in the same block', async () => {
    const blockId = freshBlockId();

    (Account.get as jest.Mock).mockResolvedValue({
      id: ADDRESS,
      identityId: '0xdid',
    } as unknown as Account);

    const before = await getOrCreateAccount(ADDRESS, blockId, datetime);
    expect(before?.identityId).toBe('0xdid');

    (Account.get as jest.Mock).mockResolvedValue({
      id: ADDRESS,
      identityId: undefined,
    } as unknown as Account);

    const after = await getOrCreateAccount(ADDRESS, blockId, datetime);
    expect(after?.identityId).toBeUndefined();
  });
});

describe('getOrCreateAccount for a multisig signer key', () => {
  beforeEach(() => {
    (api as any).query = {
      identity: { keyRecords: jest.fn().mockResolvedValue(multiSigSignerRecord) },
    };
    jest.spyOn(Account, 'get').mockResolvedValue(undefined);
  });

  /**
   * A signer key has no identity and no permissions, so there is nothing for an `Account` to
   * carry. What must not happen is the old behaviour: reading the multisig address out of the key
   * record and creating an `Identity` keyed by it.
   */
  it('indexes no account, and above all no identity keyed by the multisig address', async () => {
    await expect(getOrCreateAccount(ADDRESS, freshBlockId(), datetime)).resolves.toBeUndefined();

    expect(createIdentity).not.toHaveBeenCalled();
    expect(createPermissions).not.toHaveBeenCalled();
  });
});
