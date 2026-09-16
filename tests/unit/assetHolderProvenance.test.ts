/**
 * A17 follow-up: the asset-holder resolution chain (`rawAssetHolderToAssetHolder` ->
 * `extractAssetHolder` -> `meshAssetHolderToAssetHolder`) now threads the real `blockEventId`
 * through to `getOrCreateAccount`, rather than always taking its block-event-0 default. A caller
 * with no event to give (none currently; kept as a fallback) still gets the old behaviour.
 */

import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { getOrCreateAccount } from '../../src/utils/accounts';
import {
  extractAssetHolder,
  meshAssetHolderToAssetHolder,
  rawAssetHolderToAssetHolder,
} from '../../src/utils/portfolios';
import { codec } from './helpers';

jest.mock('../../src/utils/accounts', () => ({
  getOrCreateAccount: jest.fn(),
}));

const ADDRESS = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BLOCK_EVENT_ID = '0000012345/0000000003';

const block8x = (): SubstrateBlock =>
  ({
    specVersion: 8_000_000,
    timestamp: new Date('2026-01-01T00:00:00Z'),
  } as unknown as SubstrateBlock);

beforeEach(() => {
  (getOrCreateAccount as jest.Mock).mockResolvedValue({ identityId: '0xdid' });
});

describe('meshAssetHolderToAssetHolder', () => {
  it('passes the real blockEventId through to getOrCreateAccount when given one', async () => {
    await meshAssetHolderToAssetHolder(
      { account: ADDRESS },
      '0000012345',
      new Date('2026-01-01T00:00:00Z'),
      BLOCK_EVENT_ID
    );

    expect(getOrCreateAccount).toHaveBeenCalledWith(
      ADDRESS,
      '0000012345',
      expect.any(Date),
      BLOCK_EVENT_ID
    );
  });

  it('passes undefined through when no blockEventId is given, so getOrCreateAccount falls back on its own default', async () => {
    await meshAssetHolderToAssetHolder({ account: ADDRESS }, '0000012345', new Date());

    expect(getOrCreateAccount).toHaveBeenCalledWith(
      ADDRESS,
      '0000012345',
      expect.any(Date),
      undefined
    );
  });
});

describe('extractAssetHolder / rawAssetHolderToAssetHolder', () => {
  it('threads blockEventId all the way from the raw codec to getOrCreateAccount', async () => {
    await rawAssetHolderToAssetHolder(
      codec({ account: ADDRESS }) as unknown as Codec,
      block8x(),
      '0000012345',
      BLOCK_EVENT_ID
    );

    expect(getOrCreateAccount).toHaveBeenCalledWith(
      ADDRESS,
      '0000012345',
      expect.any(Date),
      BLOCK_EVENT_ID
    );
  });

  it('extractAssetHolder threads it too, one level up from rawAssetHolderToAssetHolder', async () => {
    await extractAssetHolder({ account: ADDRESS }, block8x(), '0000012345', BLOCK_EVENT_ID);

    expect(getOrCreateAccount).toHaveBeenCalledWith(
      ADDRESS,
      '0000012345',
      expect.any(Date),
      BLOCK_EVENT_ID
    );
  });
});
