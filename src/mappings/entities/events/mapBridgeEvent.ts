import { SubstrateEvent } from '@subql/types';
import { BridgeEvent } from '../../../types';
import { extractString, getTextValue } from '../../../utils';
import { extractArgs } from '../common';

/**
 * Subscribes to bridge events
 */
export async function handleBridgeEvent(event: SubstrateEvent): Promise<void> {
  const {
    params,
    blockId,
    eventIdx,
    block: { timestamp: datetime },
    blockEventId,
  } = extractArgs(event);
  const [rawDid, rawBridgeDetails] = params;

  const { recipient, amount, ...rest } = JSON.parse(rawBridgeDetails.toString());

  await BridgeEvent.create({
    id: blockEventId,
    identityId: getTextValue(rawDid),
    recipient,
    amount: BigInt(amount) / BigInt(1000000),
    txHash: extractString(rest, 'tx_hash'),
    eventIdx,
    datetime,
    createdBlockId: blockId,
    updatedBlockId: blockId,
    blockEventId,
  }).save();
}
