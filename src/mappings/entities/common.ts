import { Codec } from '@polkadot/types/types';
import { SubstrateBlock, SubstrateExtrinsic } from '@subql/types';
import { FunctionPropertyNames } from '@subql/types-core';
import { Asset, EventIdEnum, ModuleIdEnum } from '../../types';

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

export const getAsset = async (ticker: string): Promise<Asset> => {
  const asset = await Asset.getByTicker(ticker);

  if (!asset) {
    throw new Error(`Asset with ticker ${ticker} was not found.`);
  }

  return asset;
};
