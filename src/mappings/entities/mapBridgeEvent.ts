import { BridgeEvent, EventIdEnum, ModuleIdEnum } from '../../types';
import { extractString } from '../generatedColumns';
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
  eventIdx,
  block: { timestamp: datetime },
}: HandlerArgs): Promise<void> {
  if (moduleId === ModuleIdEnum.bridge && eventId === EventIdEnum.Bridged) {
    const [rawDid, rawBridgeDetails] = params;

    const { recipient, amount, ...rest } = JSON.parse(rawBridgeDetails.toString());

    await BridgeEvent.create({
      id: `${blockId}/${eventIdx}`,
      identityId: getTextValue(rawDid),
      recipient,
      amount: BigInt(amount) / BigInt(1000000),
      txHash: extractString(rest, 'tx_hash'),
      eventIdx,
      datetime,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  }
}
