import { Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import { FunctionPropertyNames } from '@subql/types-core';
import { Asset, EventIdEnum, ModuleIdEnum } from '../../types';
import { padId } from '../../utils';

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
  params: Codec[];
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

export function toEnum<T extends Record<string, string>>(
  enumType: T,
  value: string,
  fallback: T[keyof T]
): T[keyof T] {
  return (Object.values(enumType) as string[]).includes(value) ? (value as T[keyof T]) : fallback;
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
    eventId: toEnum(EventIdEnum, eventId, EventIdEnum.Unsupported),
    eventIdText: eventId,
    moduleId: toEnum(ModuleIdEnum, moduleId, ModuleIdEnum.unsupported),
    moduleIdText: moduleId,
    params: event.event.data,
    eventIdx: event.idx,
    block: event.block,
    extrinsic: event.extrinsic,
    extrinsicId,
    extrinsicIdx: event.extrinsic?.idx,
  };
};
