import { getAmountValue, getNumberValue, getTextValue } from '../util';
import { Investment } from './../../types';
import { serializeTicker } from './../util';
import { EventIdEnum, HandlerArgs, ModuleIdEnum } from './common';

/**
 * Subscribes to the STO Invested event
 */
export async function mapInvestment({
  blockId,
  eventId,
  moduleId,
  params,
  event,
}: HandlerArgs): Promise<void> {
  if (moduleId === ModuleIdEnum.Sto && eventId === EventIdEnum.Invested) {
    await Investment.create({
      id: `${blockId}/${event.idx}`,
      investor: getTextValue(params[0]),
      stoId: getNumberValue(params[1]),
      offeringToken: serializeTicker(params[2]),
      raiseToken: serializeTicker(params[3]),
      offeringTokenAmount: getAmountValue(params[4]),
      raiseTokenAmount: getAmountValue(params[5]),
      datetime: event.block.timestamp,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  }
}
