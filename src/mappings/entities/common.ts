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
  moduleId: ModuleIdEnum;
  eventId: EventIdEnum;
  eventIdx: number;
  params: Codec[];

  block: SubstrateBlock;

  extrinsic?: SubstrateExtrinsic;
}

export const getAsset = async (assetId: string): Promise<Asset> => {
  const asset = await Asset.get(assetId);

  if (!asset) {
    throw new Error(`Asset with ID ${assetId} was not found.`);
  }

  return asset;
};

export const extractArgs = (event: SubstrateEvent): HandlerArgs => {
  return {
    blockId: padId(event.block.block.header.number.toString()),
    eventId: event.event.method as EventIdEnum,
    moduleId: event.event.section.toLowerCase() as ModuleIdEnum,
    params: event.event.data,
    eventIdx: event.idx,
    block: event.block,
    extrinsic: event.extrinsic,
  };
};
