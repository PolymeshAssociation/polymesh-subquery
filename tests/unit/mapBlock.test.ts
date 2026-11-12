import { SubstrateBlock } from '@subql/types';
import { mapBlock } from '../../src/mappings/entities/block/mapBlock';

const record = (section: string, method: string) => ({ event: { section, method } });

describe('mapBlock', () => {
  it('counts extrinsics by signature and outcome', () => {
    const hex = { toHex: () => '0x' };
    const block = {
      block: {
        header: {
          number: { toNumber: () => 5 },
          hash: hex,
          parentHash: hex,
          stateRoot: hex,
          extrinsicsRoot: hex,
        },
        extrinsics: [{ isSigned: false }, { isSigned: true }, { isSigned: true }],
      },
      events: [
        record('system', 'ExtrinsicSuccess'),
        record('balances', 'Transfer'),
        record('system', 'ExtrinsicSuccess'),
        record('system', 'ExtrinsicFailed'),
      ],
      specVersion: 8_000_000,
      timestamp: new Date('2026-01-01T00:00:00Z'),
    } as unknown as SubstrateBlock;

    expect(mapBlock(block)).toMatchObject({
      countExtrinsics: 3,
      countExtrinsicsSigned: 2,
      countExtrinsicsUnsigned: 1,
      countExtrinsicsSuccess: 2,
      countExtrinsicsError: 1,
      countEvents: 4,
    });
  });
});
