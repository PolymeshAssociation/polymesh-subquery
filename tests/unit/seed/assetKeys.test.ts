/**
 * A scope's, leg's or offering's asset as the handlers name it (`getAssetIdWithTicker`), from the
 * chain state: before 7.0 a ticker, as text or hex, and from 7.0 an asset id with its ticker.
 */
import { SubstrateBlock } from '@subql/types';
import { assetWithTicker } from '../../../src/seed/seeders/assetKeys';
import { getAssetIdForLegacyTicker } from '../../../src/utils/assets';
import { Entry } from '../../../src/seed/snapshot';

const blockAt = (specVersion: number) => ({ specVersion } as unknown as SubstrateBlock);
const tickerEntry = (hex: string) => ({ value: { toString: () => hex } } as unknown as Entry);

describe('assetWithTicker', () => {
  it('reads a ticker before 7.0, as the canonical encoding gives it or as hex', async () => {
    const assetOf = assetWithTicker(new Map(), blockAt(6_003_050));
    const assetId = await getAssetIdForLegacyTicker('PXUSD');

    await expect(assetOf('PXUSD')).resolves.toEqual({ assetId, ticker: 'PXUSD' });
    await expect(assetOf('0x505855534400000000000000')).resolves.toEqual({
      assetId,
      ticker: 'PXUSD',
    });
  });

  it('reads an asset id from 7.0, with the ticker the chain links to it', async () => {
    const id = '0x08bda6e4a43d8199934204c57a583766';
    const assetOf = assetWithTicker(
      new Map([[id, tickerEntry('0x504f525444454d4f33000000')]]),
      blockAt(7_000_003)
    );

    await expect(assetOf(id)).resolves.toEqual({ assetId: id, ticker: 'PORTDEMO3' });
    await expect(assetOf('0x' + 'ab'.repeat(16))).resolves.toEqual({
      assetId: '0x' + 'ab'.repeat(16),
      ticker: undefined,
    });
  });
});
