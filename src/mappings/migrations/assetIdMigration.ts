import {
  AgentGroup,
  Asset,
  Authorization,
  AuthorizationStatusEnum,
  Claim,
  ClaimScopeTypeEnum,
  Compliance,
  IdentityKey,
  TickerReservation,
} from '../../types';
import { EXPLICIT_NULL, getAllByFields } from '../../utils';
import { getAssetIdForLegacyTicker } from '../../utils/assets';
import { currentComplianceForm } from '../../utils/compliance';
import {
  legacyTickerOf,
  needsAssetIdRepair,
  withAssetId,
} from '../entities/identities/repairAuthorizations';

/**
 * What 7.0's migration did to state the index holds, with no event: every ticker became the asset
 * id `AssetId::from(ticker)` gives it (`identity::ticker_migrations`, and the compliance manager's,
 * external agents' and statistics' `migrate_to_v1`), and extrinsic permissions, a list of pallets,
 * became a map by pallet name with names as text (`primitives::v6`). Rows written before it are
 * rewritten into the form 7.0's own events give; the chain rewrote only what it still held, so
 * closed and spent rows are left as they were. 7.0 also linked every ticker it held a registration
 * of to its asset id (`TickerAssetId`), an asset created under it or not.
 */

type Subset = Record<string, unknown>;

const ASSET_ID = /^0x[0-9a-fA-F]{32}$/;

/** A field by name, whatever casing the runtime's metadata gave it */
const field = (record: Subset, name: string): unknown =>
  Object.entries(record).find(([key]) => key.replace(/_/g, '').toLowerCase() === name)?.[1];

/** A pallet or extrinsic name as text, as `String::from_utf8_lossy` reads its bytes */
const nameText = (name: string): string =>
  name.startsWith('0x') ? Buffer.from(name.slice(2), 'hex').toString('utf8') : name;

/** In byte order, as a `BTreeSet` or `BTreeMap` holds its keys */
const byteOrder = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

/** A `SubsetRestriction` with `convert` applied to its members; `Whole` stays */
const mapSubset = (subset: Subset, convert: (members: unknown[]) => unknown): Subset =>
  Object.fromEntries(
    Object.entries(subset).map(([kind, members]) => [
      kind,
      Array.isArray(members) ? convert(members) : members,
    ])
  );

/** `ExtrinsicPermissions` as 7.0 holds it: a map by pallet name; already a map, it is unchanged */
export const extrinsicPermissionsToV7 = (permissions: Subset): Subset =>
  mapSubset(permissions, pallets =>
    Object.fromEntries(
      (pallets as Subset[])
        .map(pallet => {
          const names = (field(pallet, 'dispatchablenames') ?? {}) as Subset;
          return [
            nameText(field(pallet, 'palletname') as string),
            {
              extrinsics: mapSubset(names, members =>
                [...new Set((members as string[]).map(nameText))].sort(byteOrder)
              ),
            },
          ] as [string, unknown];
        })
        .sort(([a], [b]) => byteOrder(a, b))
    )
  );

const assetIdOf = (value: string): Promise<string> =>
  ASSET_ID.test(value) ? Promise.resolve(value) : getAssetIdForLegacyTicker(value);

/** `AssetPermissions` as 7.0 holds it: each ticker as its asset id */
export const assetPermissionsToV7 = async (permissions: Subset): Promise<Subset> =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(permissions).map(async ([kind, members]) => [
        kind,
        Array.isArray(members)
          ? [...new Set(await Promise.all((members as string[]).map(assetIdOf)))].sort(byteOrder)
          : members,
      ])
    )
  );

/** A JSON value with every claim scope on a ticker scoped to its asset id */
const scopesToV7 = async (value: unknown): Promise<unknown> => {
  if (Array.isArray(value)) {
    return Promise.all(value.map(scopesToV7));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const entries = Object.entries(value as Subset);
  if (entries.length === 1 && entries[0][0] === 'ticker' && typeof entries[0][1] === 'string') {
    return { asset: await assetIdOf(entries[0][1]) };
  }

  return Object.fromEntries(
    await Promise.all(entries.map(async ([key, member]) => [key, await scopesToV7(member)]))
  );
};

/** A compliance requirement's stored JSON as 7.0 holds it, in the current form */
export const complianceToV7 = async (data: string): Promise<string> =>
  JSON.stringify(await scopesToV7(currentComplianceForm(JSON.parse(data))));

/** A key's `PermissionsJson` as 7.0 holds it */
const keyPermissionsToV7 = async (permissions: Subset): Promise<Subset> => {
  const { assets, transactions } = permissions as Record<string, { type: string; values: unknown }>;
  const subset = async (
    restriction: { type: string; values: unknown } | undefined,
    convert: (subset: Subset) => Subset | Promise<Subset>
  ) =>
    restriction && Array.isArray(restriction.values)
      ? {
          ...restriction,
          values: (await convert({ [restriction.type]: restriction.values }))[restriction.type],
        }
      : restriction;

  return {
    ...permissions,
    ...(assets && { assets: await subset(assets, assetPermissionsToV7) }),
    ...(transactions && { transactions: await subset(transactions, extrinsicPermissionsToV7) }),
  };
};

/** The authorizations 7.0 rewrote whose payload is a key's `Permissions` */
const PERMISSION_AUTHORIZATIONS = new Set(['JoinIdentity', 'RotatePrimaryKeyToSecondary']);

/** A pending authorization's payload as 7.0 holds it; `undefined` for one it didn't rewrite */
const authorizationToV7 = async (row: Authorization): Promise<string | undefined> => {
  if (row.status !== AuthorizationStatusEnum.Pending || !row.data) {
    return undefined;
  }
  const ticker = legacyTickerOf(row.data);
  if (ticker && needsAssetIdRepair(row)) {
    return withAssetId(row.data, await getAssetIdForLegacyTicker(ticker));
  }
  if (!PERMISSION_AUTHORIZATIONS.has(row.type)) {
    return undefined;
  }

  // each member converted in place, so the text keeps its fields in the order the chain gives them
  const permissions = JSON.parse(row.data) as Record<string, Subset>;
  const converted = await Promise.all(
    Object.entries(permissions).map(async ([field, value]) => {
      if (field === 'asset' && value) {
        return [field, await assetPermissionsToV7(value)] as const;
      }
      if (field === 'extrinsic' && value) {
        return [field, extrinsicPermissionsToV7(value)] as const;
      }
      return [field, value] as const;
    })
  );
  return JSON.stringify(Object.fromEntries(converted));
};

/** Saves `row` with `next` when it differs from `current`, stamping the upgrade */
const rewrite = async <T extends { save(): Promise<void>; updatedEventId: string }>(
  row: T,
  current: unknown,
  next: unknown,
  apply: (row: T) => void,
  blockEventId: string
): Promise<void> => {
  if (JSON.stringify(current) === JSON.stringify(next)) {
    return;
  }
  apply(row);
  row.updatedEventId = blockEventId;
  await row.save();
};

export const migrateToAssetIds = async (blockEventId: string): Promise<void> => {
  const [keys, groups, authorizations, compliances, claims, reservations] = await Promise.all([
    getAllByFields<IdentityKey>('IdentityKey', [['validToBlockId', '=', EXPLICIT_NULL]]),
    getAllByFields<AgentGroup>('AgentGroup', []),
    getAllByFields<Authorization>('Authorization', [
      ['status', '=', AuthorizationStatusEnum.Pending],
    ]),
    getAllByFields<Compliance>('Compliance', []),
    getAllByFields<Claim>('Claim', []),
    getAllByFields<TickerReservation>('TickerReservation', []),
  ]);

  await Promise.all([
    ...keys.map(async key => {
      if (key.permissions) {
        const next = await keyPermissionsToV7(key.permissions as unknown as Subset);
        await rewrite(
          key,
          key.permissions,
          next,
          row => (row.permissions = next as unknown as IdentityKey['permissions']),
          blockEventId
        );
      }
    }),
    ...groups.map(group => {
      const next = JSON.stringify(extrinsicPermissionsToV7(JSON.parse(group.permissions)));
      return rewrite(group, group.permissions, next, row => (row.permissions = next), blockEventId);
    }),
    ...authorizations.map(async authorization => {
      const next = await authorizationToV7(authorization);
      if (next !== undefined) {
        await rewrite(
          authorization,
          authorization.data,
          next,
          row => (row.data = next),
          blockEventId
        );
      }
    }),
    ...compliances.map(async compliance => {
      const next = await complianceToV7(compliance.data);
      await rewrite(compliance, compliance.data, next, row => (row.data = next), blockEventId);
    }),
    // a scope is named by its asset's ticker beside the id, as before 7.0; a ticker that is no
    // asset has only the id from 7.0, as its events name it
    ...claims.map(async claim => {
      const { scope } = claim;
      if (
        !claim.revokeDate &&
        scope?.type === ClaimScopeTypeEnum.Asset &&
        scope.assetId &&
        !(await Asset.get(scope.assetId))
      ) {
        const next = { ...scope, value: scope.assetId };
        await rewrite(claim, scope, next, row => (row.scope = next), blockEventId);
      }
    }),
    // every registration is linked to its ticker's asset id, an asset created under it or not
    ...reservations.map(async reservation => {
      if (!reservation.assetId) {
        const next = await getAssetIdForLegacyTicker(reservation.ticker);
        await rewrite(reservation, undefined, next, row => (row.assetId = next), blockEventId);
      }
    }),
  ]);
};

/**
 * 7.1.0's `migrate_to_v6` removed each ticker link to an asset id no asset was created under, the
 * links 7.0 gave every registration. It kept the registration, announcing a new expiry with
 * `TickerRegistered` only where one was set, so a registration with no expiry lost its link silently.
 */
export const unlinkTickersOfMissingAssets = async (blockEventId: string): Promise<void> => {
  const reservations = await getAllByFields<TickerReservation>('TickerReservation', []);

  await Promise.all(
    reservations.map(async reservation => {
      if (reservation.assetId && !(await Asset.get(reservation.assetId))) {
        reservation.assetId = EXPLICIT_NULL;
        reservation.updatedEventId = blockEventId;
        await reservation.save();
      }
    })
  );
};
