import '@subql/types-core/dist/global';
import '@subql/types/dist/global';
import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { LegTypeEnum } from '../../src/types';
import { getLegsValue } from '../../src/utils/settlements';
import { mockStore } from './helpers';

const DID = `0x${'11'.repeat(32)}`;
const OTHER = `0x${'22'.repeat(32)}`;
// `ACME` as a 12-byte `Ticker`
const TICKER = `0x${Buffer.from('ACME').toString('hex').padEnd(24, '0')}`;

const block = {
  specVersion: 5_003_001,
  block: { header: { number: { toNumber: () => 8_207_205 } } },
} as unknown as SubstrateBlock;
const raw = (legs: unknown[]): Codec =>
  ({ toString: () => JSON.stringify(legs) } as unknown as Codec);

const from = { did: DID, kind: { default: null } };
const to = { did: OTHER, kind: { user: 2 } };

/**
 * v5.3's `add_instruction_with_memo_v2` announced its instruction with `InstructionV2Created`, whose
 * legs are `LegV2`: the asset is a `LegAsset` enum rather than a bare ticker beside an amount. Read
 * as a `Leg`, the enum object reached the ticker conversion and failed the block.
 */
describe('getLegsValue', () => {
  beforeEach(() => {
    mockStore();
  });

  it('reads a fungible LegV2 as the same leg a Leg gives', async () => {
    const legacy = await getLegsValue(raw([{ from, to, asset: TICKER, amount: 1_000_000 }]), block);
    const v2 = await getLegsValue(
      raw([{ from, to, asset: { fungible: { ticker: TICKER, amount: 1_000_000 } } }]),
      block
    );

    expect(v2).toEqual(legacy);
    expect(v2[0]).toMatchObject({
      legIndex: 0,
      from: DID,
      fromPortfolio: 0,
      to: OTHER,
      toPortfolio: 2,
      amount: BigInt(1_000_000),
      legType: LegTypeEnum.Fungible,
    });
  });

  it('reads a non-fungible LegV2 as an NFT leg with its ids', async () => {
    const [leg] = await getLegsValue(
      raw([{ from, to, asset: { nonFungible: { ticker: TICKER, ids: [1, 7] } } }]),
      block
    );
    const [fungible] = await getLegsValue(
      raw([{ from, to, asset: { fungible: { ticker: TICKER, amount: 1 } } }]),
      block
    );

    expect(leg).toMatchObject({
      legType: LegTypeEnum.NonFungible,
      nftIds: [BigInt(1), BigInt(7)],
      ticker: fungible.ticker,
      assetId: fungible.assetId,
    });
    expect(leg.amount).toBeUndefined();
  });
});
