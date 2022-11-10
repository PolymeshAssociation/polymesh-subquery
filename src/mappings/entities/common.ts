import { Codec } from '@polkadot/types/types';
import { FunctionPropertyNames, SubstrateEvent } from '@subql/types';
import { EventIdEnum, ModuleIdEnum } from '../../types';

export type Attributes<T> = Omit<
  T,
  NonNullable<FunctionPropertyNames<T>> | 'id' | 'createdBlockId' | 'updatedBlockId'
>;

export interface HandlerArgs {
  blockId: string;
  eventId: EventIdEnum;
  moduleId: ModuleIdEnum;
  params: Codec[];
  event: SubstrateEvent;
}
