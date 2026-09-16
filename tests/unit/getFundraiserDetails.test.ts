import '@subql/types-core/dist/global';
import '@subql/types/dist/global';

// isolate the venue-id padding path — the asset/portfolio resolution is not under test here
jest.mock('../../src/utils/assets', () => ({
  getAssetId: jest.fn(),
  getAssetIdWithTicker: jest.fn(),
}));
jest.mock('../../src/utils/portfolios', () => ({
  getPortfolioId: jest.fn(),
  meshPortfolioToAssetHolder: jest.fn(),
}));

import { getAssetId, getAssetIdWithTicker } from '../../src/utils/assets';
import { getPortfolioId, meshPortfolioToAssetHolder } from '../../src/utils/portfolios';
import { getFundraiserDetails } from '../../src/utils/stos';

const fundraiserCodec = (venueId: number | string) => ({
  toString: () =>
    JSON.stringify({
      creator: '0xcreator',
      start: null,
      end: null,
      status: 'live',
      tiers: [],
      offering_portfolio: { did: '0xdid' },
      raising_portfolio: { did: '0xdid' },
      raising_asset: '0xraising',
      offering_asset: '0xoffering',
      minimum_investment: 0,
      venue_id: venueId,
    }),
});

/**
 * Regression: `venue_id` arrives from `JSON.parse` as a JS number, and D12's `padNumericId`
 * calls `String.padStart` — so it must be coerced to a string first, or the STO handler throws
 * `padStart is not a function` on every `FundraiserCreated`.
 */
describe('getFundraiserDetails — venueId', () => {
  beforeEach(() => {
    (getAssetId as jest.Mock).mockResolvedValue('0xoffering');
    (getAssetIdWithTicker as jest.Mock).mockResolvedValue({ assetId: '0xraising', ticker: 'RAIS' });
    (getPortfolioId as jest.Mock).mockReturnValue('0xdid/0');
    (meshPortfolioToAssetHolder as jest.Mock).mockReturnValue({ identityId: '0xdid' });
  });

  it('zero-pads a numeric venue_id without throwing', async () => {
    const details = await getFundraiserDetails(
      fundraiserCodec(3) as any,
      {
        specVersion: 5_000_000,
      } as any
    );

    expect(details?.venueId).toBe('0000000003');
  });

  it('zero-pads a string venue_id', async () => {
    const details = await getFundraiserDetails(
      fundraiserCodec('42') as any,
      {
        specVersion: 5_000_000,
      } as any
    );

    expect(details?.venueId).toBe('0000000042');
  });
});
