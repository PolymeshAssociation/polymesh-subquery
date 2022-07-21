import { getBigIntValue, getNumberValue, getTextValue } from '../util';
import { EventIdEnum, Investment, ModuleIdEnum } from './../../types';
import { serializeTicker } from './../util';
import { HandlerArgs } from './common';

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
  if (moduleId === ModuleIdEnum.sto && eventId === EventIdEnum.Invested) {
    await Investment.create({
      id: `${blockId}/${event.idx}`,
      investorId: getTextValue(params[0]),
      stoId: getNumberValue(params[1]),
      offeringToken: serializeTicker(params[2]),
      raiseToken: serializeTicker(params[3]),
      offeringTokenAmount: getBigIntValue(params[4]),
      raiseTokenAmount: getBigIntValue(params[5]),
      datetime: event.block.timestamp,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  }
}
