import { Codec } from '@polkadot/types/types';
import { Account } from '../../src/types';
import { getOrCreateAccount } from '../../src/utils/accounts';

jest.mock('../../src/mappings/entities/identities/mapIdentities', () => ({
  createIdentity: jest.fn(),
  createPermissions: jest.fn(),
}));

const ADDRESS = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const OTHER = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

const keyRecords = () => (api.query as any).identity.keyRecords as jest.Mock;

const emptyRecord = { isEmpty: true } as unknown as Codec;

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

  it('serves a known account from the cache without reading the store again', async () => {
    const existing = { id: ADDRESS, identityId: '0xdid' } as unknown as Account;
    (Account.get as jest.Mock).mockResolvedValue(existing);

    const blockId = freshBlockId();

    const first = await getOrCreateAccount(ADDRESS, blockId, datetime);
    const second = await getOrCreateAccount(ADDRESS, blockId, datetime);

    expect(first).toBe(existing);
    expect(second).toBe(existing);
    expect(Account.get).toHaveBeenCalledTimes(1);
    expect(keyRecords()).not.toHaveBeenCalled();
  });
});
