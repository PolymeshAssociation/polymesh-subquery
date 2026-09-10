/**
 * `IdentityKey` — the time-bounded key membership record (defect G3).
 *
 * The headline case: a secondary key added, removed, then re-added produces a queryable history
 * with no gaps or overlaps — the first interval is closed before the second opens, and the two
 * do not share a block.
 */

import { Codec } from '@polkadot/types/types';
import { EventIdEnum, KeyRole } from '../../src/types';
import {
  closeIdentityKeys,
  openIdentityKey,
  rotateIdentityKey,
} from '../../src/mappings/entities/identities/mapIdentityKey';
import {
  legacyPermissionsUpdatedAddress,
  legacyRemovedAddresses,
  legacySecondaryKeyEntries,
  legacySignerLeftAddress,
} from '../../src/decode/legacy';

const DID = '0x01'.padEnd(66, '0');
const PRIMARY = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const SECONDARY = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

type Row = Record<string, any>;
let db: Record<string, Row>;

const matches = (row: Row, [field, op, value]: [string, string, unknown]): boolean => {
  const actual = row[field];
  if (op === '=') return actual === value;
  if (op === '!=') return actual !== value;
  throw new Error(`unhandled operator ${op}`);
};

beforeEach(() => {
  db = {};

  (store.get as jest.Mock).mockImplementation((_entity: string, id: string) =>
    Promise.resolve(db[id] ? { ...db[id] } : undefined)
  );
  (store.set as jest.Mock).mockImplementation((_entity: string, id: string, data: Row) => {
    db[id] = { ...data };
    return Promise.resolve();
  });
  (store.getByFields as jest.Mock).mockImplementation((_entity: string, filter: any[]) =>
    Promise.resolve(Object.values(db).filter(row => filter.every(f => matches(row, f))))
  );
  (store.bulkUpdate as jest.Mock).mockImplementation((_entity: string, updated: Row[]) => {
    updated.forEach(row => {
      db[row.id] = { ...row };
    });
    return Promise.resolve();
  });
});

const rows = (): Row[] => Object.values(db);
const openRows = (): Row[] => rows().filter(r => r.validToBlockId == null);

describe('openIdentityKey', () => {
  it('opens an interval with null validTo / removedReason', async () => {
    await openIdentityKey(
      {
        identityId: DID,
        address: PRIMARY,
        role: KeyRole.Primary,
        addedReason: EventIdEnum.DidCreated,
        eventIdx: 0,
      },
      '0000001'
    );

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      identityId: DID,
      accountId: PRIMARY,
      role: KeyRole.Primary,
      validFromBlockId: '0000001',
      addedReason: EventIdEnum.DidCreated,
    });
    expect(rows()[0].validToBlockId).toBeUndefined();
    expect(rows()[0].removedReason).toBeUndefined();
  });
});

describe('closeIdentityKeys', () => {
  it('closes only the open interval of the named role', async () => {
    await openIdentityKey(
      {
        identityId: DID,
        address: PRIMARY,
        role: KeyRole.Primary,
        addedReason: EventIdEnum.DidCreated,
        eventIdx: 0,
      },
      '0000001'
    );
    await openIdentityKey(
      {
        identityId: DID,
        address: SECONDARY,
        role: KeyRole.Secondary,
        addedReason: EventIdEnum.SecondaryKeysAdded,
        eventIdx: 0,
      },
      '0000002'
    );

    const closed = await closeIdentityKeys(
      {
        address: SECONDARY,
        role: KeyRole.Secondary,
        removedReason: EventIdEnum.SecondaryKeysRemoved,
      },
      '0000005'
    );

    expect(closed).toHaveLength(1);
    expect(openRows().map(r => r.accountId)).toEqual([PRIMARY]);
    const secondary = rows().find(r => r.accountId === SECONDARY);
    expect(secondary).toMatchObject({
      validToBlockId: '0000005',
      removedReason: EventIdEnum.SecondaryKeysRemoved,
    });
  });

  it('is a no-op when nothing is open', async () => {
    const closed = await closeIdentityKeys(
      { address: SECONDARY, removedReason: EventIdEnum.SecondaryKeyLeftIdentity },
      '0000009'
    );
    expect(closed).toHaveLength(0);
  });
});

describe('rotateIdentityKey', () => {
  it('closes the current interval and opens a fresh one carrying the new permissions', async () => {
    await openIdentityKey(
      {
        identityId: DID,
        address: SECONDARY,
        role: KeyRole.Secondary,
        permissions: { transactionGroups: [] },
        addedReason: EventIdEnum.SecondaryKeysAdded,
        eventIdx: 0,
      },
      '0000002'
    );

    await rotateIdentityKey(
      {
        address: SECONDARY,
        role: KeyRole.Secondary,
        reason: EventIdEnum.SecondaryKeyPermissionsUpdated,
        eventIdx: 3,
        permissions: { transactionGroups: ['Portfolio'] },
      },
      '0000007'
    );

    const history = rows()
      .filter(r => r.accountId === SECONDARY)
      .sort((a, b) => a.validFromBlockId.localeCompare(b.validFromBlockId));

    expect(history).toHaveLength(2);
    // no gap and no overlap: the old interval ends exactly where the new one begins
    expect(history[0].validToBlockId).toBe('0000007');
    expect(history[1].validFromBlockId).toBe('0000007');
    expect(history[1].validToBlockId).toBeUndefined();
    expect(history[1].permissions).toEqual({ transactionGroups: ['Portfolio'] });
  });
});

describe('G1 — active secondary keys exclude the primary', () => {
  it('a primary and a secondary on one identity filter apart by role', async () => {
    await openIdentityKey(
      {
        identityId: DID,
        address: PRIMARY,
        role: KeyRole.Primary,
        addedReason: EventIdEnum.DidCreated,
        eventIdx: 0,
      },
      '0000001'
    );
    await openIdentityKey(
      {
        identityId: DID,
        address: SECONDARY,
        role: KeyRole.Secondary,
        addedReason: EventIdEnum.SecondaryKeysAdded,
        eventIdx: 0,
      },
      '0000001'
    );

    const activeSecondary = rows().filter(
      r => r.identityId === DID && r.role === KeyRole.Secondary && r.validToBlockId == null
    );

    expect(activeSecondary.map(r => r.accountId)).toEqual([SECONDARY]);
    expect(activeSecondary.some(r => r.accountId === PRIMARY)).toBe(false);
  });
});

describe('add → remove → re-add', () => {
  it('produces a two-interval history with the first closed before the second opens', async () => {
    await openIdentityKey(
      {
        identityId: DID,
        address: SECONDARY,
        role: KeyRole.Secondary,
        addedReason: EventIdEnum.SecondaryKeysAdded,
        eventIdx: 0,
      },
      '0000010'
    );
    await closeIdentityKeys(
      {
        address: SECONDARY,
        role: KeyRole.Secondary,
        removedReason: EventIdEnum.SecondaryKeysRemoved,
      },
      '0000020'
    );
    await openIdentityKey(
      {
        identityId: DID,
        address: SECONDARY,
        role: KeyRole.Secondary,
        addedReason: EventIdEnum.SecondaryKeysAdded,
        eventIdx: 0,
      },
      '0000030'
    );

    const history = rows()
      .filter(r => r.accountId === SECONDARY)
      .sort((a, b) => a.validFromBlockId.localeCompare(b.validFromBlockId));

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ validFromBlockId: '0000010', validToBlockId: '0000020' });
    expect(history[1].validFromBlockId).toBe('0000030');
    expect(history[1].validToBlockId).toBeUndefined();
    // no overlap: interval 1 closes (block 20) strictly before interval 2 opens (block 30)
    expect(history[0].validToBlockId < history[1].validFromBlockId).toBe(true);
    expect(openRows()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The pre-5.0 payload unwrapping relocated out of the handlers (src/decode/legacy.ts)
// ---------------------------------------------------------------------------

const codec = (json: unknown): Codec =>
  ({
    toString: () => (typeof json === 'string' ? json : JSON.stringify(json)),
    toJSON: () => json,
  } as unknown as Codec);

describe('legacy identity payloads', () => {
  it('legacyRemovedAddresses reads both the pre-5.0 Signatory and 5.0+ AccountId forms', () => {
    expect(legacyRemovedAddresses(codec([{ account: PRIMARY }, { account: SECONDARY }]))).toEqual([
      PRIMARY,
      SECONDARY,
    ]);
    expect(legacyRemovedAddresses(codec([PRIMARY, SECONDARY]))).toEqual([PRIMARY, SECONDARY]);
  });

  it('legacySignerLeftAddress reads both forms', () => {
    expect(legacySignerLeftAddress(codec({ account: PRIMARY }))).toBe(PRIMARY);
    expect(legacySignerLeftAddress(codec(PRIMARY))).toBe(PRIMARY);
  });

  it('legacyPermissionsUpdatedAddress reads the 5.0+ AccountId form', () => {
    expect(legacyPermissionsUpdatedAddress(codec(SECONDARY))).toBe(SECONDARY);
  });

  it('legacyPermissionsUpdatedAddress unwraps the pre-5.0 SecondaryKey struct', () => {
    const struct = new Map<string, Codec>([['signer', codec({ account: SECONDARY })]]);
    expect(legacyPermissionsUpdatedAddress(struct as unknown as Codec)).toBe(SECONDARY);
  });

  it('legacySecondaryKeyEntries reads the 5.0+ `key` and pre-5.0 `signer` entries', () => {
    const post = codec([{ key: SECONDARY, permissions: { foo: 1 } }]);
    expect(legacySecondaryKeyEntries(post)).toEqual([
      { address: SECONDARY, permissions: { foo: 1 } },
    ]);

    const pre = codec([{ signer: { account: SECONDARY }, permissions: { foo: 1 } }]);
    expect(legacySecondaryKeyEntries(pre)).toEqual([
      { address: SECONDARY, permissions: { foo: 1 } },
    ]);
  });
});
