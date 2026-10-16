import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { getLegV2Values } from '../../src/utils/legV2';

const DID_A = '0x0a'.padEnd(66, '0');
const DID_B = '0x0b'.padEnd(66, '0');
const TICKER = '0x5449434b4552000000000000';
const block = { specVersion: 5003001 } as unknown as SubstrateBlock;
const from = { did: DID_A, kind: { default: null } };
const to = { did: DID_B, kind: { user: 2 } };
const legsOf = (legs: unknown[]): Codec => ({ toJSON: () => legs } as unknown as Codec);

// testnet block 8,207,205
describe('getLegV2Values', () => {
  it('reads a fungible leg from its `LegAsset`', async () => {
    const [leg] = await getLegV2Values(
      legsOf([{ from, to, asset: { fungible: { ticker: TICKER, amount: 5 } } }]),
      block
    );
    expect(leg).toMatchObject({
      legIndex: 0,
      ticker: 'TICKER',
      amount: BigInt(5),
      legType: 'Fungible',
      fromId: DID_A,
      fromPortfolioId: `${DID_A}/0`,
      toId: DID_B,
      toPortfolioId: `${DID_B}/2`,
    });
  });

  it('reads an NFT leg from its `LegAsset`', async () => {
    const [leg] = await getLegV2Values(
      legsOf([{ from, to, asset: { nonFungible: { ticker: TICKER, ids: [1, 2] } } }]),
      block
    );
    expect(leg).toMatchObject({
      ticker: 'TICKER',
      nftIds: [BigInt(1), BigInt(2)],
      legType: 'NonFungible',
    });
    expect(leg.amount).toBeUndefined();
  });
});
