import { SubstrateEvent } from '@subql/types';
import { BridgeEvent } from '../../../types';
import { extractString, getAccountKey, getTextValue } from '../../../utils';
import { extractArgs } from '../common';

/**
 * Subscribes to bridge events
 */
export async function handleBridgeEvent(event: SubstrateEvent): Promise<void> {
  const { params, blockEventId } = extractArgs(event);
  const [rawDid, rawBridgeDetails] = params;

  const { recipient, amount, ...rest } = JSON.parse(rawBridgeDetails.toString());

  await BridgeEvent.create({
    id: blockEventId,
    identityId: getTextValue(rawDid),
    // the payload may render the key as hex; Account rows are keyed by SS58 address
    recipientId: getAccountKey(recipient, api.registry.chainSS58),
    amount: BigInt(amount) / BigInt(1000000),
    txHash: extractString(rest, 'tx_hash'),
    createdEventId: blockEventId,
  }).save();
}
