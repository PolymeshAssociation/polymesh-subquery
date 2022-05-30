import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { BridgeEvent } from '../../types';
import { getTextValue } from '../util';
import { EventIdEnum, ModuleIdEnum } from './common';

/**
 * Subscribes to event
 */
export async function mapBridgeEvent(
  blockId: number,
  eventId: string,
  moduleId: string,
  params: Codec[],
  event: SubstrateEvent
): Promise<void> {
  if (moduleId === ModuleIdEnum.Bridge && eventId === EventIdEnum.Bridged) {
    if (params[1] instanceof Map) {
      await BridgeEvent.create({
        id: `${blockId}/${event.idx}`,
        blockId,
        eventIdx: event.idx,
        identityId: getTextValue(params[0]),
        recipient: getTextValue(params[1].get('recipient')),
        amount: params[1].get('amount'),
        txHash: getTextValue(params[1].get('tx_hash')),
        datetime: event.block.timestamp,
      }).save();
    } else {
      throw new Error("Couldn't find tx_hash for bridge event");
    }
  }
}
