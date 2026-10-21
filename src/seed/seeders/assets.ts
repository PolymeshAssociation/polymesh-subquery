import { Codec } from '@polkadot/types/types';
import { detailFrom } from '../../mappings/entities/assets/mapAssetMetadata';
import {
  isStoredSchedule,
  ParsedSchedule,
  StoredScheduleJson,
  storedScheduleFields,
} from '../../mappings/entities/assets/mapCheckpoint';
import { MetadataKey, parseMetadataKey } from '../../mappings/entities/assets/metadataKeyResolver';
import {
  AgentGroup,
  AgentGroupMembership,
  Asset,
  AssetAgent,
  AssetDocument,
  AssetMandatoryMediator,
  AssetMetadata,
  AssetPreApproval,
  Checkpoint,
  CheckpointSchedule,
  CustomAssetType,
  GlobalMetadataKey,
  MetadataScope,
  TickerReservation,
} from '../../types';
import {
  builtInAssetType,
  customTypeIdOf,
  getAssetIdForLegacyTicker,
  getDocValue,
  getSecurityIdentifiers,
} from '../../utils/assets';
import { jsonOf, memberOf } from '../../utils/codec';
import { getBigIntValue, getBooleanValue, getTextValue, hexToString } from '../../utils/common';
import { pageRows, SeedContext, Seeder } from '../seeder';
import { ChainSnapshot, Entry, StorageRef } from '../snapshot';
import { assetIdOf, assetIds, identityHoldings } from './assetKeys';
import { canonicalExtrinsicPermissions, Subset } from '../../utils/permissions';
import { requiredText, storedText } from '../../utils/text';

const created = (ctx: SeedContext) => ({
  createdEventId: ctx.eventId,
  updatedEventId: ctx.eventId,
});

/**
 * The rows `build` makes of each entry of an item keyed by asset, a page at a time; `assetArg` is
 * the key argument that names the asset.
 */
async function* byAsset<T>(
  snap: ChainSnapshot,
  item: StorageRef,
  build: (entry: Entry & { value: Codec }, assetId: string) => T[],
  assetArg = 0
): AsyncGenerator<T[]> {
  for await (const page of snap.pages(item)) {
    yield await pageRows(page, async entry =>
      entry.value
        ? build(entry as Entry & { value: Codec }, await assetIdOf(entry.args[assetArg]))
        : []
    );
  }
}

export const customAssetTypeSeeder: Seeder<CustomAssetType> = {
  entity: 'CustomAssetType',
  reads: ['asset.customTypes'],
  async *rows(snap, ctx) {
    for await (const page of snap.pages('asset.customTypes')) {
      yield page.flatMap(({ args, value }) =>
        value
          ? [
              CustomAssetType.create({
                id: args[0].toString(),
                name: requiredText(value, 'a custom asset type name'),
                ...created(ctx),
              }),
            ]
          : []
      );
    }
  },
};

/** The items an asset's row is read from, each whole, by the asset's storage key */
interface AssetViews {
  names: ReadonlyMap<string, Entry>;
  fundingRounds: ReadonlyMap<string, Entry>;
  identifiers: ReadonlyMap<string, Entry>;
  frozen: ReadonlyMap<string, Entry>;
  compliances: ReadonlyMap<string, Entry>;
  tickers: ReadonlyMap<string, Entry>;
  customTypes: ReadonlyMap<string, Entry>;
  collections: ReadonlyMap<string, Entry>;
  holdings: Awaited<ReturnType<typeof identityHoldings>>;
}

const assetViews = async (snap: ChainSnapshot, byAssetId: boolean): Promise<AssetViews> => {
  const [
    names,
    fundingRounds,
    identifiers,
    frozen,
    compliances,
    tickers,
    customTypes,
    holdings,
    collections,
  ] = await Promise.all([
    snap.map('asset.assetNames'),
    snap.map('asset.fundingRound'),
    snap.map(byAssetId ? 'asset.assetIdentifiers' : 'asset.identifiers'),
    snap.map('asset.frozen'),
    snap.map('complianceManager.assetCompliances'),
    snap.map('asset.assetIdTicker'),
    snap.map('asset.customTypes'),
    identityHoldings(snap),
    // a collection by asset from 7.0, by ticker before
    snap.map(byAssetId ? 'nft.collectionAsset' : 'nft.collectionTicker'),
  ]);
  return {
    names,
    fundingRounds,
    identifiers,
    frozen,
    compliances,
    tickers,
    customTypes,
    collections,
    holdings,
  };
};

/** An asset type's name; an unregistered custom type stays unknown, as the creation handler leaves it */
const assetType = ({ customTypes }: AssetViews, raw: Codec): string | undefined => {
  const custom = customTypeIdOf(raw);
  if (!custom) {
    return builtInAssetType(raw);
  }
  const name = customTypes.get(custom.toString())?.value;
  return storedText(name);
};

const assetRow = (
  views: AssetViews,
  {
    key,
    assetId,
    details,
    byAssetId,
  }: { key: string; assetId: string; details: Codec; byAssetId: boolean },
  ctx: SeedContext
): Asset => {
  const held = [...(views.holdings.get(assetId)?.values() ?? [])];
  const rawTicker = byAssetId ? views.tickers.get(key)?.value?.toString() : key;
  const ids = views.identifiers.get(key)?.value;
  const compliance = views.compliances.get(key)?.value?.toJSON() as { paused?: boolean } | null;
  // the chain keeps no supply for a collection, and the handlers count the tokens issued
  const tokens = held.reduce((sum, { nftCount }) => sum + BigInt(nftCount), BigInt(0));
  return Asset.create({
    id: assetId,
    assetId,
    ticker: rawTicker ? hexToString(rawTicker) : undefined,
    name: storedText(views.names.get(key)?.value),
    type: assetType(views, memberOf(details, 'assetType')),
    isNftCollection: views.collections.has(key),
    fundingRound: storedText(views.fundingRounds.get(key)?.value),
    isDivisible: getBooleanValue(memberOf(details, 'divisible')),
    isFrozen: views.frozen.get(key)?.value?.toJSON() === true,
    holderCount: held.filter(({ amount, nftCount }) => amount > BigInt(0) || nftCount > 0).length,
    identifiers: ids ? getSecurityIdentifiers(ids) : [],
    ownerId: getTextValue(memberOf(details, 'ownerDid')),
    totalSupply: getBigIntValue(memberOf(details, 'totalSupply')) + tokens,
    totalTransfers: BigInt(0),
    isCompliancePaused: Boolean(compliance?.paused),
    ...created(ctx),
  });
};

/**
 * An asset as its creation and configuration left it: supply, owner, divisibility, type, name,
 * funding round, identifiers, freeze and compliance pause, and how many identities hold it. From
 * 7.0 `asset.assets` by asset id; before it `asset.tokens` by ticker, the asset id derived from it.
 */
export const assetSeeder: Seeder<Asset> = {
  entity: 'Asset',
  reads: [
    'asset.assets',
    'asset.tokens',
    'asset.assetNames',
    'asset.fundingRound',
    'asset.assetIdentifiers',
    'asset.identifiers',
    'asset.frozen',
    'asset.assetIdTicker',
    'asset.customTypes',
    'complianceManager.assetCompliances',
    'asset.balanceOf',
    'nft.numberOfNFTs',
    'nft.collectionAsset',
    'nft.collectionTicker',
  ],
  relative: ['totalTransfers'],
  async *rows(snap, ctx) {
    const byAssetId = snap.has('asset.assets');
    const views = await assetViews(snap, byAssetId);
    for await (const page of snap.pages(byAssetId ? 'asset.assets' : 'asset.tokens')) {
      yield await pageRows(page, async ({ args, value: details }) => {
        if (!details) {
          return [];
        }
        const key = args[0].toString();
        const assetId = byAssetId ? key : await getAssetIdForLegacyTicker(key);
        return [assetRow(views, { key, assetId, details, byAssetId }, ctx)];
      });
    }
  },
};

/**
 * A ticker's registration, with its owner, expiry and asset: `asset.uniqueTickerRegistration` and
 * `asset.tickerAssetId` from 7.0, before it `asset.tickers`, whose asset is the one created under
 * the ticker. The genesis config registers the fiat tickers and the classic ones this way.
 */
export const tickerReservationSeeder: Seeder<TickerReservation> = {
  entity: 'TickerReservation',
  reads: [
    'asset.uniqueTickerRegistration',
    'asset.tickerAssetId',
    'asset.tickers',
    'asset.assets',
    'asset.tokens',
  ],
  oldShapes: { 'asset.tickers': [3000] },
  async *rows(snap, ctx) {
    const byAssetId = snap.has('asset.uniqueTickerRegistration');
    const [linked, assets] = await Promise.all([snap.map('asset.tickerAssetId'), assetIds(snap)]);
    /** The asset a ticker is linked to: by `tickerAssetId` from 7.0, before it the one created under it */
    const reservedAsset = async (key: string): Promise<string | undefined> => {
      if (byAssetId) {
        return linked.get(key)?.value?.toString();
      }
      const legacy = await getAssetIdForLegacyTicker(key);
      return assets.has(legacy) ? legacy : undefined;
    };
    for await (const page of snap.pages(
      byAssetId ? 'asset.uniqueTickerRegistration' : 'asset.tickers'
    )) {
      yield await pageRows(page, async ({ args, value }) => {
        if (!value) {
          return [];
        }
        const key = args[0].toString();
        const ticker = hexToString(key);
        const { owner, expiry } = value.toJSON() as { owner: string; expiry: number | null };
        return [
          TickerReservation.create({
            id: ticker,
            ticker,
            identityId: owner,
            expiry: expiry === null || expiry === undefined ? undefined : new Date(Number(expiry)),
            assetId: await reservedAsset(key),
            ...created(ctx),
          }),
        ];
      });
    }
  },
};

export const assetDocumentSeeder: Seeder<AssetDocument> = {
  entity: 'AssetDocument',
  reads: ['asset.assetDocuments'],
  rows: (snap, ctx) =>
    byAsset(snap, 'asset.assetDocuments', ({ args, value }, assetId) => [
      AssetDocument.create({
        id: `${assetId}/${args[1].toString()}`,
        documentId: Number(args[1].toString()),
        ...getDocValue(value),
        assetId,
        ...created(ctx),
      }),
    ]),
};

export const globalMetadataKeySeeder: Seeder<GlobalMetadataKey> = {
  entity: 'GlobalMetadataKey',
  reads: ['asset.assetMetadataGlobalKeyToName', 'asset.assetMetadataGlobalSpecs'],
  async *rows(snap, ctx) {
    const specs = await snap.map('asset.assetMetadataGlobalSpecs');
    for await (const page of snap.pages('asset.assetMetadataGlobalKeyToName')) {
      yield page.flatMap(({ args, value }) => {
        const id = args[0].toString();
        const spec = specs.get(id)?.value;
        return value
          ? [
              GlobalMetadataKey.create({
                id,
                name: requiredText(value, 'a global metadata key name'),
                spec: spec ? JSON.stringify(spec.toJSON()) : undefined,
                ...created(ctx),
              }),
            ]
          : [];
      });
    }
  },
};

/**
 * An asset's metadata entry: a value with its lock and expiry, named by its local key or the
 * global key map. A local key registered with no value has a row, as registering it gives it one;
 * a global key has one only where the asset holds a value for it.
 */
export const assetMetadataSeeder: Seeder<AssetMetadata> = {
  entity: 'AssetMetadata',
  reads: [
    'asset.assetMetadataLocalKeyToName',
    'asset.assetMetadataGlobalKeyToName',
    'asset.assetMetadataValues',
    'asset.assetMetadataValueDetails',
  ],
  async *rows(snap, ctx) {
    const [localNames, globalNames, details] = await Promise.all([
      snap.map('asset.assetMetadataLocalKeyToName'),
      snap.map('asset.assetMetadataGlobalKeyToName'),
      snap.map('asset.assetMetadataValueDetails'),
    ]);
    const row = (
      assetId: string,
      key: MetadataKey,
      name?: Codec,
      value?: Codec,
      detail?: Codec
    ) => {
      const { isLocked, lockedUntil, expiry } = detailFrom(detail?.toJSON());
      return AssetMetadata.create({
        id: `${assetId}/${key.scope}/${key.keyId}`,
        assetId,
        scope: key.scope,
        keyId: key.keyId,
        name: storedText(name),
        value: storedText(value),
        isLocked,
        lockedUntil,
        expiry,
        ...created(ctx),
      });
    };
    const valued = new Set<string>();

    yield* byAsset(snap, 'asset.assetMetadataValues', ({ args, value }, assetId) => {
      const key = parseMetadataKey(args[1].toJSON());
      if (!key) {
        return [];
      }
      const assetKey = args[0].toString();
      valued.add(`${assetKey}/${key.scope}/${key.keyId}`);
      const name =
        key.scope === MetadataScope.Local
          ? localNames.get(`${assetKey}/${key.keyId}`)?.value
          : globalNames.get(key.keyId)?.value;
      return [
        row(assetId, key, name, value, details.get(`${assetKey}/${args[1].toString()}`)?.value),
      ];
    });

    yield await pageRows([...localNames.values()], async ({ args, value }) => {
      const keyId = args[1].toString();
      return value && !valued.has(`${args[0].toString()}/${MetadataScope.Local}/${keyId}`)
        ? [row(await assetIdOf(args[0]), { scope: MetadataScope.Local, keyId }, value)]
        : [];
    });
  },
};

export const agentGroupSeeder: Seeder<AgentGroup> = {
  entity: 'AgentGroup',
  reads: ['externalAgents.groupPermissions'],
  rows: (snap, ctx) =>
    byAsset(snap, 'externalAgents.groupPermissions', ({ args, value }, assetId) => [
      AgentGroup.create({
        id: `${assetId}/${args[1].toString()}`,
        assetId,
        permissions: JSON.stringify(canonicalExtrinsicPermissions(value.toJSON() as Subset)),
        ...created(ctx),
      }),
    ]),
};

export const assetAgentSeeder: Seeder<AssetAgent> = {
  entity: 'AssetAgent',
  reads: ['externalAgents.groupOfAgent'],
  rows: (snap, ctx) =>
    byAsset(snap, 'externalAgents.groupOfAgent', ({ args }, assetId) => [
      AssetAgent.create({
        id: `${assetId}/${args[1].toString()}`,
        assetId,
        identityId: args[1].toString(),
        ...created(ctx),
      }),
    ]),
};

/** An agent's membership of a custom group; the built-in groups keep none */
export const agentGroupMembershipSeeder: Seeder<AgentGroupMembership> = {
  entity: 'AgentGroupMembership',
  reads: ['externalAgents.groupOfAgent'],
  rows: (snap, ctx) =>
    byAsset(snap, 'externalAgents.groupOfAgent', ({ args, value }, assetId) => {
      const group = (value.toJSON() as { custom?: number } | null)?.custom;
      const did = args[1].toString();
      return group === undefined || group === null
        ? []
        : [
            AgentGroupMembership.create({
              id: `${assetId}/${group}/${did}`,
              memberId: did,
              groupId: `${assetId}/${group}`,
              ...created(ctx),
            }),
          ];
    }),
};

/**
 * A checkpoint, with its moment and total supply, linked to the schedule that produced it while
 * the chain still holds that schedule.
 */
export const checkpointSeeder: Seeder<Checkpoint> = {
  entity: 'Checkpoint',
  relative: ['scheduleId'],
  reads: [
    'checkpoint.timestamps',
    'checkpoint.totalSupply',
    'checkpoint.schedulePoints',
    'checkpoint.scheduledCheckpoints',
  ],
  async *rows(snap, ctx) {
    const [supplies, points, schedules] = await Promise.all([
      snap.map('checkpoint.totalSupply'),
      snap.map('checkpoint.schedulePoints'),
      snap.map('checkpoint.scheduledCheckpoints'),
    ]);
    const scheduleOf = new Map<string, string>();
    for (const { args, value } of points.values()) {
      const schedule = args.map(String).join('/');
      if (schedules.has(schedule)) {
        ((value?.toJSON() as number[] | null) ?? []).forEach(checkpointId =>
          scheduleOf.set(`${args[0].toString()}/${checkpointId}`, args[1].toString())
        );
      }
    }
    yield* byAsset(snap, 'checkpoint.timestamps', ({ args, value }, assetId) => {
      const key = args.map(String).join('/');
      const scheduleId = scheduleOf.get(key);
      return [
        Checkpoint.create({
          id: `${assetId}/${args[1].toString()}`,
          assetId,
          checkpointId: Number(args[1].toString()),
          totalSupply: BigInt(supplies.get(key)?.value?.toString() ?? 0),
          datetime: new Date(Number(value.toString())),
          scheduleId: scheduleId ? `${assetId}/${scheduleId}` : undefined,
          createdEventId: ctx.eventId,
        }),
      ];
    });
  },
};

const isStoredSchedules = (json: unknown): json is StoredScheduleJson[] =>
  Array.isArray(json) && json.every(isStoredSchedule);

/**
 * A checkpoint schedule the chain still holds. From 6.0 it lists the moments it has still to fire;
 * those it fired, which an index lists from its creation, are history. Before 6.0 it is a period
 * and a count, an asset's schedules held in one list.
 */
export const checkpointScheduleSeeder: Seeder<CheckpointSchedule> = {
  entity: 'CheckpointSchedule',
  reads: ['checkpoint.scheduledCheckpoints', 'checkpoint.schedules'],
  oldShapes: { 'checkpoint.schedules': [3000, 5000002] },
  relative: ['scheduledCheckpoints'],
  terminal: ({ removedEventId, completedEventId }) => Boolean(removedEventId || completedEventId),
  rows: (snap, ctx) => {
    const scheduleRow = (assetId: string, schedule: ParsedSchedule) =>
      CheckpointSchedule.create({
        id: `${assetId}/${schedule.scheduleId}`,
        assetId,
        ...schedule,
        createdEventId: ctx.eventId,
      });
    return snap.has('checkpoint.schedules')
      ? byAsset(snap, 'checkpoint.schedules', ({ value }, assetId) =>
          jsonOf(value, isStoredSchedules, 'checkpoint.schedules').map(stored =>
            scheduleRow(assetId, storedScheduleFields(stored))
          )
        )
      : byAsset(snap, 'checkpoint.scheduledCheckpoints', ({ args, value }, assetId) => [
          scheduleRow(assetId, {
            scheduleId: Number(args[1].toString()),
            scheduledCheckpoints: ((value.toJSON() as { pending?: number[] }).pending ?? []).map(
              moment => new Date(moment)
            ),
          }),
        ]);
  },
};

/** A mediator every instruction moving the asset needs; who added it the chain doesn't keep */
export const assetMandatoryMediatorSeeder: Seeder<AssetMandatoryMediator> = {
  entity: 'AssetMandatoryMediator',
  relative: ['addedById'],
  reads: ['asset.mandatoryMediators'],
  rows: (snap, ctx) =>
    byAsset(snap, 'asset.mandatoryMediators', ({ value }, assetId) =>
      ((value.toJSON() as string[] | null) ?? []).map(did =>
        AssetMandatoryMediator.create({
          id: `${assetId}/${did}`,
          assetId,
          identityId: did,
          ...created(ctx),
        })
      )
    ),
};

/**
 * An identity's pre-approval of an asset: `asset.preApprovedAsset` from 7.0, before it
 * `asset.preApprovedTicker`, both keyed by identity, then asset. Written even for a ticker that is
 * no asset, as the handler writes it.
 */
export const assetPreApprovalSeeder: Seeder<AssetPreApproval> = {
  entity: 'AssetPreApproval',
  reads: ['asset.preApprovedAsset', 'asset.preApprovedTicker'],
  async *rows(snap, ctx) {
    const item = snap.has('asset.preApprovedAsset')
      ? 'asset.preApprovedAsset'
      : 'asset.preApprovedTicker';
    yield* byAsset(
      snap,
      item,
      ({ args, value }, assetId) =>
        value.toJSON() === true
          ? [
              AssetPreApproval.create({
                id: `${assetId}/${args[0].toString()}`,
                assetId,
                identityId: args[0].toString(),
                ...created(ctx),
              }),
            ]
          : [],
      1
    );
  },
};
