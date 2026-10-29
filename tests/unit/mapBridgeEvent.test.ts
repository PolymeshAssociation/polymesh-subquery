import { encodeAddress } from '@polkadot/util-crypto';
import { handleBridgeEvent } from '../../src/mappings/entities/events/mapBridgeEvent';
import { codec, mockStore, tupleEvent } from './helpers';

const KEY = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';

describe('handleBridgeEvent', () => {
  it('records the recipient as the SS58 address its Account row is keyed by', async () => {
    const db = mockStore();
    (globalThis as any).api.registry = { chainSS58: 12 };

    await handleBridgeEvent(
      tupleEvent({
        section: 'bridge',
        method: 'Bridged',
        data: [
          codec('0x0a'.padEnd(66, '0')),
          codec(JSON.stringify({ nonce: 1, recipient: KEY, amount: 2000000, tx_hash: '0x1' })),
        ],
      })
    );

    expect(Object.values(db.BridgeEvent)[0]).toMatchObject({ recipientId: encodeAddress(KEY, 12) });
  });
});
