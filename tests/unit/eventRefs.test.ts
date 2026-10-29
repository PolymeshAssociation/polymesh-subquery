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

  it('files a ticker under its asset id and as itself before v7', async () => {
    expect(await toEventRefs([{ kind: 'ticker', value: TICKER_HEX }], 5_004_000)).toEqual([
      `asset:${await getAssetIdForLegacyTicker(TICKER_HEX)}`,
      'ticker:ABC',
    ]);
  });

  it('files a ticker as itself from v7, so an event naming only a ticker is found', async () => {
    expect(await toEventRefs([{ kind: 'ticker', value: TICKER_HEX }], 7_000_000)).toEqual([
      'ticker:ABC',
    ]);
  });

  it('files both an asset id and a ticker from v7, once each', async () => {
    const asset = `0x${'33'.repeat(16)}`;
    expect(
      await toEventRefs(
        [
          { kind: 'asset', value: asset },
          { kind: 'ticker', value: TICKER_HEX },
          { kind: 'ticker', value: TICKER_HEX },
        ],
        8_000_000
      )
    ).toEqual([`asset:${asset}`, 'ticker:ABC']);
  });

  it('files a ticker that is not text as its hex', async () => {
    const hex = '0xff4243000000000000000000';
    expect(await toEventRefs([{ kind: 'ticker', value: hex }], 8_000_000)).toEqual([
      `ticker:${hex}`,
    ]);
  });

  it('is undefined when the event refers to nothing', async () => {
    expect(await toEventRefs([], 8_000_000)).toBeUndefined();
  });
});
