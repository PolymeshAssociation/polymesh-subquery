import { BridgeEvent, EventIdEnum, ModuleIdEnum } from '../../types';
import { getTextValue } from '../util';
import { HandlerArgs } from './common';

/**
 * Subscribes to bridge events
 */
export async function mapBridgeEvent({
  blockId,
  eventId,
  moduleId,
  params,
  event,
}: HandlerArgs): Promise<void> {
  if (moduleId === ModuleIdEnum.bridge && eventId === EventIdEnum.Bridged) {
    const [rawDid, rawBridgeDetails] = params;

    const { recipient, amount, tx_hash: txHash } = JSON.parse(rawBridgeDetails.toString());

    await BridgeEvent.create({
      id: `${blockId}/${event.idx}`,
      identityId: getTextValue(rawDid),
      recipient,
      amount: BigInt(amount) / BigInt(1000000),
      txHash,
      eventIdx: event.idx,
      datetime: event.block.timestamp,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  }
}
