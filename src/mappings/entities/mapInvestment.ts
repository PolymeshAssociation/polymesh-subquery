import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { getBigIntValue, getTextValue } from '../util';
import { Investment } from './../../types';
import { serializeTicker } from './../util';
import { EventIdEnum, ModuleIdEnum } from './common';

/**
 * Subscribes to the STO Invested event
 */
export async function mapInvestment(
  blockId: string,
  eventId: EventIdEnum,
  moduleId: ModuleIdEnum,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> {
  if (moduleId === ModuleIdEnum.Sto && eventId === EventIdEnum.Invested) {
    await Investment.create({
      id: `${blockId}/${event.idx}`,
      blockId,
      investor: getTextValue(params[0]),
      stoId: Number(params[1].toString()),
      offeringToken: serializeTicker(params[2]),
      raiseToken: serializeTicker(params[3]),
      offeringTokenAmount: getBigIntValue(params[4]),
      raiseTokenAmount: getBigIntValue(params[5]),
      datetime: event.block.timestamp,
    }).save();
  }
}
