import { AnyTuple } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import { FunctionPropertyNames } from '@subql/types-core';
import { AnomalyKind, Asset, EventIdEnum, ModuleIdEnum } from '../../types';
import { padId } from '../../utils';
import { recordAnomaly } from '../../utils/anomaly';

export type Attributes<T> = Omit<
  T,
  | NonNullable<FunctionPropertyNames<T>>
  | 'id'
  | 'createdBlockId'
  | 'updatedBlockId'
  | 'createdEventId'
  | 'updatedEventId'
  | '_name'
>;

export interface HandlerArgs {
  blockId: string;
  blockEventId: string;
  moduleId: ModuleIdEnum;
  eventId: EventIdEnum;
  eventIdText: string;
  moduleIdText: string;
  eventIdx: number;
  params: AnyTuple;
  block: SubstrateBlock;
  extrinsic?: SubstrateExtrinsic;
  extrinsicId?: string;
  extrinsicIdx?: number;
}

export const getAsset = async (assetId: string): Promise<Asset> => {
  const asset = await Asset.get(assetId);

  if (!asset) {
    throw new Error(`Asset with ID ${assetId} was not found.`);
  }

  return asset;
};

/**
 * `getAsset`, but records a `MissingReferencedEntity` anomaly and returns `undefined` instead of
 * throwing. For handlers where a missing asset is a data gap to note, not a reason to fail the
 * whole block — e.g. an `AssetBalanceUpdated` whose `AssetCreated` was skipped upstream.
 */
export const getAssetOrAnomaly = async (
  assetId: string,
  context: { block: SubstrateBlock; eventIdx?: number; eventId?: EventIdEnum }
): Promise<Asset | undefined> => {
  const asset = await Asset.get(assetId);

  if (asset) {
    return asset;
  }

  await recordAnomaly({
    kind: AnomalyKind.MissingReferencedEntity,
    detail: `Asset ${assetId} was not found — its creation event was not indexed`,
    block: context.block,
    eventIdx: context.eventIdx,
    eventId: context.eventId,
  });

  return undefined;
};

/**
 * A row a handler needs but the index does not hold, recorded rather than returned as a bare
 * `undefined`.
 *
 * Every "the thing this event refers to was never indexed" case means one of two things: the event
 * that created it was missed, or the two handlers disagree about how the id is built. Both are worth
 * knowing, and a silent `return` leaves no trace of either. Callers still decide what to do with
 * `undefined` — this only makes sure the miss is on the record.
 */
export const getOrAnomaly = async <T>(
  read: (id: string) => Promise<T | undefined>,
  id: string,
  entity: string,
  event: SubstrateEvent
): Promise<T | undefined> => {
  const found = await read(id);

  if (found) {
    return found;
  }

  const { block, eventIdx, moduleId, eventId } = extractArgs(event);

  await recordAnomaly({
    kind: AnomalyKind.MissingReferencedEntity,
    detail: `${eventId} found no ${entity} at id "${id}"`,
    block,
    eventIdx,
    moduleId,
    eventId,
  });

  return undefined;
};

/**
 * Context that lets an unmapped chain value be recorded as an `IndexerAnomaly` instead of
 * silently becoming `Unknown`. Optional so a caller with no block in hand still type checks,
 * but every call site inside a handler has one and should pass it.
 */
export interface EnumContext {
  /** Name of the schema enum, so the anomaly says which enum is missing the value */
  enumName: string;
  block: SubstrateBlock;
  eventIdx?: number;
}

/**
 * Maps a chain value onto a schema enum member, recording an anomaly when it maps onto nothing.
 *
 * `fallback` is optional, and leaving it out is the right choice whenever every member of the enum
 * is a meaningful value rather than a catch-all: writing one of two opposites on an unrecognised
 * value states something the chain did not say. Omitting it stores nothing, which a nullable column
 * can express and the anomaly still reports.
 */
export function toEnum<T extends Record<string, string>>(
  enumType: T,
  value: string,
  fallback?: T[keyof T],
  context?: EnumContext
): T[keyof T] | undefined {
  if (Object.values(enumType).includes(value)) {
    return value as T[keyof T];
  }

  if (context) {
    /**
     * Dropped deliberately: `toEnum` is on a synchronous path and the row is a diagnostic.
     * See `recordAnomaly`
     */
    void recordAnomaly({
      kind: AnomalyKind.UnknownEnumValue,
      detail:
        `${context.enumName} has no member "${value}"; ` +
        (fallback === undefined ? 'left unset' : `recorded as "${fallback}"`),
      block: context.block,
      eventIdx: context.eventIdx,
      dedupeKey: `${context.enumName}/${value}`,
    });
  }

  return fallback;
}

export const extractArgs = (event: SubstrateEvent): HandlerArgs => {
  const blockId = padId(event.block.block.header.number.toString());
  const blockEventId = `${blockId}/${padId(event.idx.toString())}`;
  const extrinsicId = event.extrinsic?.idx
    ? `${blockId}/${padId(event.extrinsic.idx.toString())}`
    : undefined;

  const eventId = event.event.method;
  const moduleId = event.event.section.toLowerCase();

  return {
    blockId,
    blockEventId,
    eventId: toEnum(EventIdEnum, eventId, EventIdEnum.Unknown, {
      enumName: 'EventIdEnum',
      block: event.block,
      eventIdx: event.idx,
    }),
    eventIdText: eventId,
    moduleId: toEnum(ModuleIdEnum, moduleId, ModuleIdEnum.unknown, {
      enumName: 'ModuleIdEnum',
      block: event.block,
      eventIdx: event.idx,
    }),
    moduleIdText: moduleId,
    params: event.event.data as unknown as AnyTuple,
    eventIdx: event.idx,
    block: event.block,
    extrinsic: event.extrinsic,
    extrinsicId,
    extrinsicIdx: event.extrinsic?.idx,
  };
};
