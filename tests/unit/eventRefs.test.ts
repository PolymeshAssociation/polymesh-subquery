import { toEventRefs } from '../../src/mappings/args/refs';
import { getAssetIdForLegacyTicker } from '../../src/utils';

const DID = `0x${'22'.repeat(32)}`;
const TICKER_HEX = '0x414243000000000000000000';

describe('toEventRefs', () => {
  it('files each distinct reference once, as kind:value in order', async () => {
    expect(
      await toEventRefs(
        [
          { kind: 'identity', value: DID },
          { kind: 'identity', value: DID },
          { kind: 'account', value: '5Grw' },
          { kind: 'portfolio', value: `${DID}/1` },
        ],
        8_000_000
      )
    ).toEqual([`identity:${DID}`, 'account:5Grw', `portfolio:${DID}/1`]);
  });

  it('files a ticker under the asset it maps to before v7, and under nothing from v7', async () => {
    expect(await toEventRefs([{ kind: 'ticker', value: TICKER_HEX }], 5_004_000)).toEqual([
      `asset:${await getAssetIdForLegacyTicker(TICKER_HEX)}`,
    ]);

    expect(await toEventRefs([{ kind: 'ticker', value: TICKER_HEX }], 7_000_000)).toBeUndefined();
  });

  it('is undefined when the event refers to nothing', async () => {
    expect(await toEventRefs([], 8_000_000)).toBeUndefined();
  });
});
