import { toEventReferences } from '../../src/mappings/args/references';
import { getAssetIdForLegacyTicker } from '../../src/utils';

const DID = `0x${'22'.repeat(32)}`;
const TICKER_HEX = '0x414243000000000000000000';

describe('toEventReferences', () => {
  it('writes one row per distinct reference, numbered in order', async () => {
    const rows = await toEventReferences(
      [
        { kind: 'identity', value: DID, argument: 'did' },
        { kind: 'identity', value: DID, argument: 'target' },
        { kind: 'account', value: '5Grw', argument: 'who' },
      ],
      '0000000001/0000000002',
      8_000_000
    );

    expect(rows.map(r => [r.id, r.kind, r.value, r.argument])).toEqual([
      ['0000000001/0000000002/0000000000', 'Identity', DID, 'did'],
      ['0000000001/0000000002/0000000001', 'Account', '5Grw', 'who'],
    ]);
  });

  it('refers to the asset a ticker maps to before v7, and to nothing from v7', async () => {
    const before = await toEventReferences(
      [{ kind: 'ticker', value: TICKER_HEX, argument: '1' }],
      '0000000001/0000000000',
      5_004_000
    );
    expect(before.map(r => [r.kind, r.value])).toEqual([
      ['Asset', await getAssetIdForLegacyTicker(TICKER_HEX)],
    ]);

    expect(
      await toEventReferences(
        [{ kind: 'ticker', value: TICKER_HEX, argument: '1' }],
        '0000000001/0000000000',
        7_000_000
      )
    ).toEqual([]);
  });
});
