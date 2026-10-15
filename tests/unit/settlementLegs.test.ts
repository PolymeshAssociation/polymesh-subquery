import '@subql/types-core/dist/global';
import '@subql/types/dist/global';
import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { LegTypeEnum } from '../../src/types';
import { getLegsValue, instructionPartiesOf } from '../../src/utils/settlements';
import { mockStore } from './helpers';

const DID = `0x${'11'.repeat(32)}`;
const OTHER = `0x${'22'.repeat(32)}`;
// `ACME` as a 12-byte `Ticker`
const TICKER = `0x${Buffer.from('ACME').toString('hex').padEnd(24, '0')}`;

const DID_A = '0x0a'.padEnd(66, '0');
const DID_B = '0x0b'.padEnd(66, '0');
const ADDRESS = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

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

describe('instructionPartiesOf', () => {
  it('keeps an account party’s DID in identity and its address in account', () => {
    const parties = instructionPartiesOf([
      { from: DID_A, fromAccount: ADDRESS, to: DID_B, toPortfolio: 1 },
    ]);
    expect(parties.get(ADDRESS)).toEqual({
      identity: DID_A,
      account: ADDRESS,
      portfolios: undefined,
    });
    expect(parties.get(DID_B)).toEqual({ identity: DID_B, account: undefined, portfolios: [1] });
  });

  it('merges one party across legs without dropping portfolios', () => {
    const parties = instructionPartiesOf([
      { from: DID_A, fromPortfolio: 0, to: DID_B, toPortfolio: 1 },
      { from: DID_B, fromPortfolio: 2, to: DID_A, toPortfolio: 0 },
    ]);
    expect(parties.get(DID_A)?.portfolios).toEqual([0]);
    expect(parties.get(DID_B)?.portfolios).toEqual([1, 2]);
  });

  it('keys an account with no identity by its address alone', () => {
    const parties = instructionPartiesOf([
      { from: undefined as unknown as string, fromAccount: ADDRESS, to: DID_B, toPortfolio: 0 },
    ]);
    expect(parties.get(ADDRESS)).toEqual({
      identity: undefined,
      account: ADDRESS,
      portfolios: undefined,
    });
    expect([...parties.keys()]).not.toContain('undefined');
  });

  it('records an off-chain party with no portfolios', () => {
    const parties = instructionPartiesOf([{ from: DID_A, to: DID_B }]);
    expect(parties.get(DID_A)).toEqual({
      identity: DID_A,
      account: undefined,
      portfolios: undefined,
    });
  });
});
