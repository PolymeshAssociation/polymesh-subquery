import { Codec } from '@polkadot/types/types';
import { getAccountId, systematicIssuers } from '../../mappings/consts';
import { getPermissions } from '../../mappings/entities/identities/mapIdentities';
import { identityKeyId } from '../../mappings/entities/identities/mapIdentityKey';
import {
  Account,
  AccountKeyRole,
  EventIdEnum,
  Identity,
  IdentityKey,
  IdentityKeyRole,
  Portfolio,
} from '../../types';
import { getAccountKeyType } from '../../utils/accounts';
import { bytesToString, EXPLICIT_NULL, extractValue, getTextValue } from '../../utils/common';
import { SeedContext, Seeder, SeedRow } from '../seeder';
import { ChainSnapshot } from '../snapshot';
import { primaryKeyOf, StoredKey, storedKeys } from './keys';

/** The identities the chain's constants give the systematic issuers, which no record lists at genesis */
const systematic = (): { did: string; primaryAccountId: string }[] =>
  Object.values(systematicIssuers).map(({ did, accountId }) => ({
    did,
    primaryAccountId: getAccountId(accountId, api.registry.chainSS58),
  }));

/** Every identity's DID: those `identity.didRecords` holds, then the systematic issuers it doesn't */
const identityDids = (snap: ChainSnapshot): Promise<string[]> =>
  snap.derive('identityDids', async () => {
    const records = await snap.map('identity.didRecords');
    return [
      ...[...records].filter(([, { value }]) => primaryKeyOf(value)).map(([did]) => did),
      ...systematic()
        .map(({ did }) => did)
        .filter(did => !records.has(did)),
    ];
  });

export const identitySeeder: Seeder<Identity> = {
  entity: 'Identity',
  reads: ['identity.didRecords', 'identity.isDidFrozen'],
  oldShapes: { 'identity.didRecords': [3000] },
  accounts: ['primaryAccountId'],
  async *rows(snap, ctx) {
    const [records, frozen] = await Promise.all([
      snap.map('identity.didRecords'),
      snap.map('identity.isDidFrozen'),
    ]);
    const row = (did: string, primaryAccountId: string | undefined) =>
      Identity.create({
        id: did,
        did,
        primaryAccountId,
        secondaryKeysFrozen: frozen.get(did)?.value?.toJSON() === true,
        createdEventId: ctx.eventId,
        updatedEventId: ctx.eventId,
      });
    // a record with no key isn't an identity: before 7.0 each asset had one, which no DidCreated
    // announced
    yield [...records].flatMap(([did, { value }]) => {
      const primaryKey = primaryKeyOf(value);
      return primaryKey ? [row(did, primaryKey)] : [];
    });
    yield systematic()
      .filter(({ did }) => !records.has(did))
      .map(({ did, primaryAccountId }) => row(did, primaryAccountId));
  },
};

export const accountRow = (address: string, key: StoredKey | undefined, ctx: SeedContext) =>
  Account.create({
    id: address,
    address,
    identityId: key?.did,
    keyRole: key?.role ?? AccountKeyRole.Unlinked,
    ...getAccountKeyType(address),
    createdEventId: ctx.eventId,
    updatedEventId: ctx.eventId,
  });

/**
 * Every account the chain holds: each key it records, an identity's or a multisig signer's, and each
 * account it keeps, funded or not, unlinked when no key record names it. An index keeps a row for
 * every address it has seen, so an unlinked one the chain no longer holds is history.
 */
export const accountSeeder: Seeder<Account> = {
  entity: 'Account',
  reads: [
    'identity.keyRecords',
    'identity.keyToIdentityIds',
    'identity.didRecords',
    'system.account',
  ],
  oldShapes: {
    'identity.keyToIdentityIds': [3000],
    'identity.didRecords': [3000],
    'system.account': [3000],
  },
  terminal: ({ keyRole, identityId }) => keyRole === AccountKeyRole.Unlinked && !identityId,
  async *rows(snap, ctx) {
    const keys = await storedKeys(snap);
    yield [...keys.values()].map(key => accountRow(key.address, key, ctx));
    for await (const page of snap.pages('system.account')) {
      yield page
        .map(({ args }) => args[0].toString())
        .filter(address => !keys.has(address))
        .map(address => accountRow(address, undefined, ctx));
    }
  },
};

/** Account rows for addresses no key record names: unlinked, as `ledgerAccount` makes them */
export const accountRows = async (
  addresses: string[],
  snap: ChainSnapshot,
  ctx: SeedContext
): Promise<SeedRow[]> => {
  const keys = await storedKeys(snap);
  return addresses.map(address => accountRow(address, keys.get(address), ctx));
};

/** A key's permissions as an `IdentityKey` keeps them */
const permissionsOf = (raw: unknown) => {
  if (!raw) {
    return undefined;
  }
  const { assets, portfolios, transactions, transactionGroups } = getPermissions(
    raw as Record<string, unknown>
  );
  return { assets, portfolios, transactions, transactionGroups };
};

interface OpenKey {
  did: string;
  address: string;
  role: IdentityKeyRole;
  permissions?: unknown;
  /** its place among its identity's keys, which the interval id carries */
  index: number;
}

/**
 * Each identity's keys. From 5.0 the key records say whose each key is, and from 7.0 a secondary
 * key's permissions are three items of their own. Before 5.0 an identity's record lists its keys.
 */
const openKeys = async (snap: ChainSnapshot): Promise<OpenKey[]> => {
  if (!snap.has('identity.keyRecords')) {
    const keys: OpenKey[] = [];
    for (const [did, { value }] of await snap.map('identity.didRecords')) {
      const record = value?.toJSON();
      const primary = primaryKeyOf(value);
      if (primary) {
        keys.push({ did, address: primary, role: IdentityKeyRole.PrimaryKey, index: 0 });
      }
      const secondaries = extractValue<{ signer?: { account?: string }; permissions?: unknown }[]>(
        record,
        'secondary_keys'
      );
      (secondaries ?? []).forEach(({ signer, permissions }, i) => {
        if (signer?.account) {
          keys.push({
            did,
            address: signer.account,
            role: IdentityKeyRole.SecondaryKey,
            permissions,
            index: i + 1,
          });
        }
      });
    }
    return keys;
  }

  const split = snap.has('identity.keyExtrinsicPermissions');
  const [asset, extrinsic, portfolio] = split
    ? await Promise.all([
        snap.map('identity.keyAssetPermissions'),
        snap.map('identity.keyExtrinsicPermissions'),
        snap.map('identity.keyPortfolioPermissions'),
      ])
    : [];
  const jsonOf = (entries: ReadonlyMap<string, { value?: Codec }> | undefined, address: string) =>
    entries?.get(address)?.value?.toJSON();

  return [...(await storedKeys(snap)).values()].flatMap(({ address, did, role, permissions }) => {
    if (!did) {
      return [];
    }
    const primary = role === AccountKeyRole.PrimaryKey;
    return [
      {
        did,
        address,
        role: primary ? IdentityKeyRole.PrimaryKey : IdentityKeyRole.SecondaryKey,
        permissions:
          primary || !split
            ? permissions
            : {
                asset: jsonOf(asset, address),
                extrinsic: jsonOf(extrinsic, address),
                portfolio: jsonOf(portfolio, address),
              },
        index: 0,
      },
    ];
  });
};

/** Each key's open membership interval, from the start block */
export const identityKeySeeder: Seeder<IdentityKey> = {
  entity: 'IdentityKey',
  key: ({ identityId, accountId }) => `${identityId}/${accountId}`,
  terminal: ({ validToBlockId }) => Boolean(validToBlockId),
  reads: [
    'identity.keyRecords',
    'identity.keyToIdentityIds',
    'identity.didRecords',
    'identity.keyAssetPermissions',
    'identity.keyExtrinsicPermissions',
    'identity.keyPortfolioPermissions',
  ],
  oldShapes: { 'identity.keyToIdentityIds': [3000], 'identity.didRecords': [3000] },
  accounts: ['accountId'],
  // the event that opened an interval is history; the seed's open at the seed
  relative: ['addedReason'],
  async *rows(snap, ctx) {
    yield (await openKeys(snap)).map(({ did, address, role, permissions, index }) =>
      IdentityKey.create({
        id: identityKeyId(did, address, ctx.blockId, index),
        identityId: did,
        accountId: address,
        role,
        permissions: role === IdentityKeyRole.SecondaryKey ? permissionsOf(permissions) : undefined,
        validFromBlockId: ctx.blockId,
        validToBlockId: EXPLICIT_NULL,
        addedReason: EventIdEnum.Seeded,
        createdEventId: ctx.eventId,
        updatedEventId: ctx.eventId,
      })
    );
  },
};

/** `did/number` of a `PortfolioId`'s JSON, `{ did, kind: 'default' | { user: n } }` */
const portfolioIdOf = (json: unknown): string => {
  const { did, kind } = json as { did: string; kind: unknown };
  const user =
    typeof kind === 'object' && kind !== null ? (kind as { user?: number }).user : undefined;
  return `${did}/${user ?? 0}`;
};

/** Every identity's default portfolio, and the user portfolios `portfolio.portfolios` names */
export const portfolioSeeder: Seeder<Portfolio> = {
  entity: 'Portfolio',
  terminal: ({ deletedAt }) => Boolean(deletedAt),
  reads: ['identity.didRecords', 'portfolio.portfolios', 'portfolio.portfolioCustodian'],
  oldShapes: { 'identity.didRecords': [3000] },
  async *rows(snap, ctx) {
    const custodians = new Map(
      [...(await snap.map('portfolio.portfolioCustodian')).values()].map(({ args, value }) => [
        portfolioIdOf(args[0].toJSON()),
        value ? getTextValue(value) : undefined,
      ])
    );
    const row = (id: string, name?: string) => {
      const [did, number] = id.split('/');
      return Portfolio.create({
        id,
        identityId: did,
        number: Number(number),
        name,
        // an owner holding its own portfolio has no custodian, as the handlers record it
        custodianId: custodians.get(id) === did ? undefined : custodians.get(id),
        createdEventId: ctx.eventId,
        updatedEventId: ctx.eventId,
      });
    };
    yield (await identityDids(snap)).map(did => row(`${did}/0`));
    for await (const page of snap.pages('portfolio.portfolios')) {
      yield page.map(({ args, value }) =>
        row(`${args[0].toString()}/${args[1].toString()}`, value ? bytesToString(value) : undefined)
      );
    }
  },
};
