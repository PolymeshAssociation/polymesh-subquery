/**
 * The asset-holder resolution chain (`rawAssetHolderToAssetHolder` ->
 * `extractAssetHolder` -> `meshAssetHolderToAssetHolder`) threads the real `blockEventId` through
 * to `getOrCreateAccount`.
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
    await meshAssetHolderToAssetHolder({ account: ADDRESS }, '0000012345', BLOCK_EVENT_ID);

    expect(getOrCreateAccount).toHaveBeenCalledWith(ADDRESS, '0000012345', BLOCK_EVENT_ID);
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

    expect(getOrCreateAccount).toHaveBeenCalledWith(ADDRESS, '0000012345', BLOCK_EVENT_ID);
  });

  it('extractAssetHolder threads it too, one level up from rawAssetHolderToAssetHolder', async () => {
    await extractAssetHolder({ account: ADDRESS }, block8x(), '0000012345', BLOCK_EVENT_ID);

    expect(getOrCreateAccount).toHaveBeenCalledWith(ADDRESS, '0000012345', BLOCK_EVENT_ID);
  });
});
