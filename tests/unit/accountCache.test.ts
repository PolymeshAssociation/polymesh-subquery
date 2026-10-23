import { TypeRegistry } from '@polkadot/types';
import { Codec } from '@polkadot/types/types';
import { __resetBlockContext } from '../../src/mappings/blockContext';
import { Account, AccountKeyRole, Identity } from '../../src/types';
import { getOrCreateAccount, upsertAccount } from '../../src/utils/accounts';
import { createIdentity } from '../../src/mappings/entities/identities/mapIdentities';
import { createPortfolio } from '../../src/mappings/entities/identities/mapPortfolio';

jest.mock('../../src/mappings/entities/identities/mapIdentities', () => ({
  createIdentity: jest.fn(),
}));

jest.mock('../../src/mappings/entities/identities/mapPortfolio', () => ({
  createPortfolio: jest.fn(),
}));

const ADDRESS = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const OTHER = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const DID = '0x01'.padEnd(66, '0');

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
const freshBlockId = () => {
  // a lookup only opens the block it is first asked about; a later block starts from nothing
  __resetBlockContext();

  return `${nextBlock++}`.padStart(10, '0');
};

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
   * A signer key has no identity, so there is nothing for an `Account` to carry. What must not
   * happen is the old behaviour: reading the multisig address out of the key record and creating
   * an `Identity` keyed by it.
   */
  it('indexes no account, and above all no identity keyed by the multisig address', async () => {
    await expect(getOrCreateAccount(ADDRESS, freshBlockId(), datetime)).resolves.toBeUndefined();

    expect(createIdentity).not.toHaveBeenCalled();
  });
});

describe('getOrCreateAccount for keys of one unindexed identity resolved concurrently', () => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));

  const keyRecord = (kind: 'primary' | 'secondary') =>
    ({
      isEmpty: false,
      unwrap: () => ({
        isPrimaryKey: kind === 'primary',
        isSecondaryKey: kind === 'secondary',
        asPrimaryKey: { toString: () => DID },
        asSecondaryKey: { toString: () => DID },
      }),
    } as unknown as Codec);

  let identities: Record<string, any>;

  beforeEach(() => {
    identities = {};
    (globalThis as any).api.registry = { chainSS58: 12 };
    (createIdentity as jest.Mock).mockReset();
    (createPortfolio as jest.Mock).mockReset().mockResolvedValue(undefined);

    (api as any).query = {
      identity: {
        keyRecords: jest.fn(async (address: string) =>
          keyRecord(address === ADDRESS ? 'primary' : 'secondary')
        ),
      },
    };
    jest.spyOn(Account, 'get').mockResolvedValue(undefined);
    jest.spyOn(Account.prototype, 'save').mockResolvedValue(undefined);
    jest.spyOn(Identity, 'get').mockImplementation(async id => identities[id]);
    // the write lands a tick after it is issued, as a store write does
    (createIdentity as jest.Mock).mockImplementation(async args => {
      await tick();
      identities[args.did] = { ...args };
    });
  });

  /**
   * Both keys read no identity if they run side by side, both create it, and whichever write lands
   * last wins: the secondary key resolved first can leave itself as the primary account.
   */
  it('ends with the primary key as primary account and one default portfolio', async () => {
    const blockId = freshBlockId();

    await Promise.all([
      getOrCreateAccount(OTHER, blockId, datetime),
      getOrCreateAccount(ADDRESS, blockId, datetime),
    ]);

    expect(identities[DID].primaryAccountId).toBe(ADDRESS);
    expect(createPortfolio).toHaveBeenCalledTimes(1);
  });
});

describe('getOrCreateAccount for a 5.x or 6.x secondary key', () => {
  /**
   * Until 7.0 a secondary key's record is `SecondaryKey(IdentityId, Permissions)`, so the record's
   * value is a pair, and the identity is its first member.
   */
  it('files the key under the identity the pair names', async () => {
    const registry = new TypeRegistry();
    const pair = registry.createType('(H256, u32)', [DID, 0]);
    (globalThis as any).api.registry = { chainSS58: 12 };
    (api as any).query = {
      identity: {
        keyRecords: jest.fn(async () => ({
          isEmpty: false,
          unwrap: () => ({ isPrimaryKey: false, isSecondaryKey: true, asSecondaryKey: pair }),
        })),
      },
    };
    jest.spyOn(Account, 'get').mockResolvedValue(undefined);
    jest.spyOn(Account.prototype, 'save').mockResolvedValue(undefined);
    jest.spyOn(Identity, 'get').mockResolvedValue({ id: DID, primaryAccountId: ADDRESS } as never);

    const account = await getOrCreateAccount(OTHER, freshBlockId(), datetime);

    expect(account).toMatchObject({ identityId: DID, keyRole: AccountKeyRole.SecondaryKey });
  });
});

describe('upsertAccount', () => {
  beforeEach(() => {
    (globalThis as any).api.registry = { chainSS58: 12 };
  });

  /**
   * A primary-key rotation re-announces a key that was a secondary key a moment earlier. Writing
   * the row afresh there would move its provenance to the rotation.
   */
  it('updates an existing row and leaves its createdEvent alone', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const existing: any = {
      id: ADDRESS,
      address: ADDRESS,
      identityId: undefined,
      keyRole: AccountKeyRole.Unlinked,
      createdEventId: '0000000100/0000000000',
      updatedEventId: '0000000100/0000000000',
      save,
    };
    jest.spyOn(Account, 'get').mockResolvedValue(existing);
    const created = jest.spyOn(Account.prototype, 'save').mockResolvedValue(undefined);

    await upsertAccount(
      {
        address: ADDRESS,
        identityId: DID,
        keyRole: AccountKeyRole.PrimaryKey,
      },
      '0000000200/0000000003'
    );

    expect(created).not.toHaveBeenCalled();
    expect(existing.createdEventId).toBe('0000000100/0000000000');
    expect(existing.updatedEventId).toBe('0000000200/0000000003');
    expect(existing.keyRole).toBe(AccountKeyRole.PrimaryKey);
    expect(existing.identityId).toBe(DID);
    expect(save).toHaveBeenCalled();
  });
});
