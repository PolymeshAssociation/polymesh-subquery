import '@subql/types-core/dist/global';
import '@subql/types/dist/global';
import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { LegTypeEnum } from '../../src/types';
import {
  getLegsValue,
  instructionPartiesOf,
  processOffChainLegForTest,
} from '../../src/utils/settlements';
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
  block: { header: { number: { toNumber: () => 1 } } },
} as unknown as SubstrateBlock;
const raw = (legs: unknown[]): Codec =>
  ({ toString: () => JSON.stringify(legs) } as unknown as Codec);

const from = { did: DID, kind: { default: null } };
const to = { did: OTHER, kind: { user: 2 } };

describe('getLegsValue', () => {
  beforeEach(() => {
    mockStore();
  });

  it('reads a v5 Leg, its ticker and amount beside its portfolios', async () => {
    const [leg] = await getLegsValue(raw([{ from, to, asset: TICKER, amount: 1_000_000 }]), block);

    expect(leg).toMatchObject({
      legIndex: 0,
      fromId: DID,
      fromPortfolioId: `${DID}/0`,
      toId: OTHER,
      toPortfolioId: `${OTHER}/2`,
      ticker: 'ACME',
      amount: BigInt(1_000_000),
      legType: LegTypeEnum.Fungible,
    });
  });
});

describe('instructionPartiesOf', () => {
  it('keeps one party per DID across its accounts and portfolios', () => {
    const parties = instructionPartiesOf([
      { fromId: DID_A, fromAccountId: ADDRESS, toId: DID_B, toPortfolioId: `${DID_B}/1` },
      { fromId: DID_A, fromPortfolioId: `${DID_A}/1`, toId: DID_B, toPortfolioId: `${DID_B}/2` },
    ]);
    expect([...parties.keys()]).toEqual([DID_A, DID_B]);
    expect(parties.get(DID_A)).toEqual({ identityId: DID_A, accountId: undefined });
    expect(parties.get(DID_B)).toEqual({ identityId: DID_B, accountId: undefined });
  });

  it('keys an account with no identity by its address', () => {
    const parties = instructionPartiesOf([
      { fromAccountId: ADDRESS, toId: DID_B, toPortfolioId: `${DID_B}/0` },
    ]);
    expect(parties.get(ADDRESS)).toEqual({ identityId: undefined, accountId: ADDRESS });
    expect([...parties.keys()]).toEqual([ADDRESS, DID_B]);
  });

  it('records an off-chain party', () => {
    const parties = instructionPartiesOf([{ fromId: DID_A, toId: DID_B }]);
    expect(parties.get(DID_A)).toEqual({ identityId: DID_A, accountId: undefined });
  });
});

describe('processOffChainLeg', () => {
  it('gives an off-chain leg no asset, only its ticker', () => {
    const leg = processOffChainLegForTest(
      { sender_identity: DID_A, receiver_identity: DID_B, ticker: '0x5449434b4552', amount: '5' },
      0
    );
    expect(leg).toMatchObject({ assetId: undefined, ticker: 'TICKER', fromId: DID_A, toId: DID_B });
  });
});
