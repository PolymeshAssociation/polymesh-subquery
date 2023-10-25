import { Codec } from '@polkadot/types/types';
import { FunctionPropertyNames, SubstrateEvent } from '@subql/types';
import { Asset, EventIdEnum, ModuleIdEnum } from '../../types';

export type Attributes<T> = Omit<
  T,
  NonNullable<FunctionPropertyNames<T>> | 'id' | 'createdBlockId' | 'updatedBlockId' | '_name'
>;

export interface HandlerArgs {
  blockId: string;
  eventId: EventIdEnum;
  moduleId: ModuleIdEnum;
  params: Codec[];
  event: SubstrateEvent;
}

export const getAsset = async (ticker: string): Promise<Asset> => {
  const asset = await Asset.getByTicker(ticker);

  if (!asset) {
    throw new Error(`Asset with ticker ${ticker} was not found.`);
  }

  return asset;
};
