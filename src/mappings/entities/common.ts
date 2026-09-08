import { AnyTuple } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import { FunctionPropertyNames } from '@subql/types-core';
import { AnomalyKind, Asset, EventIdEnum, ModuleIdEnum } from '../../types';
import { padId } from '../../utils';
import { recordAnomaly } from '../../utils/anomaly';

export type Attributes<T> = Omit<
  T,
  NonNullable<FunctionPropertyNames<T>> | 'id' | 'createdBlockId' | 'updatedBlockId' | '_name'
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

export function toEnum<T extends Record<string, string>>(
  enumType: T,
  value: string,
  fallback: T[keyof T],
  context?: EnumContext
): T[keyof T] {
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
      detail: `${context.enumName} has no member "${value}"; recorded as "${fallback}"`,
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
